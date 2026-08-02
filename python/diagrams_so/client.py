"""Diagrams.so API client (stdlib-only; no hard dependency).

Uses ``requests`` if installed, else falls back to ``urllib``. Keeps the package
dependency-free so it drops into any environment.
"""

from __future__ import annotations

import json as _json
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

DEFAULT_BASE = "https://api.diagrams.so/api/v2"


class DiagramsAPIError(Exception):
    """Raised for any non-2xx API response. Carries the house error envelope."""

    def __init__(self, code: str, message: str, status: int, request_id: Optional[str] = None):
        super().__init__(f"[{code}] (HTTP {status}) {message}")
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id


# Errors where a billable call's outcome is UNKNOWN — the work may have completed
# and been charged server-side even though this process saw a failure. Retrying
# with the SAME Idempotency-Key replays the stored result instead of re-running
# (and re-billing). Definite rejections (401/402/404/422 …) are deliberately absent.
_AMBIGUOUS_STATUSES = {502, 503, 504, 409}
_AMBIGUOUS_CODES = {"TIMEOUT", "CONNECTION_ERROR", "IDEMPOTENCY_IN_PROGRESS"}


def is_ambiguous(err: Exception) -> bool:
    """True if ``err`` leaves a billable call's outcome unknown (safe to retry with
    the same Idempotency-Key)."""
    if not isinstance(err, DiagramsAPIError):
        return False
    return err.status in _AMBIGUOUS_STATUSES or err.code in _AMBIGUOUS_CODES


class DiagramsClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE, timeout: float = 450.0,
                 max_retries: int = 3, backoff: float = 0.5,
                 retry_delays: "tuple[float, ...]" = (5.0, 15.0, 30.0),
                 retry_budget: float = 600.0):
        if not api_key:
            raise ValueError("api_key is required (dgz_live_… or dgz_test_…)")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        # 450s sits ABOVE the server-side timeout ladder (LLM worst-case ~160s <
        # gunicorn 300s < nginx 330s < ALB 360s) so the client never aborts work
        # the server would still deliver (and bill for).
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff = backoff
        # Bounded same-key retry for billable calls on AMBIGUOUS failures
        # (timeout / 5xx / idempotency-in-progress). Delays in seconds; the whole
        # billable call — including retries — is capped at retry_budget seconds.
        self.retry_delays = tuple(retry_delays)
        self.retry_budget = retry_budget
        # Identify this client so the API attributes charges to source="sdk-python"
        # in the credit-consumption history (X-Diagrams-Client wins; User-Agent is a
        # fallback). Import here to avoid a circular import at module load.
        from . import __version__ as _v
        self._client_id = f"sdk-python/{_v}"
        self._user_agent = f"diagrams-so-python/{_v}"
        # Running tally of credits this client charged in-process — answers
        # "how much did each task cost?" instantly, no server round-trip.
        self.session_charges: List[Dict[str, Any]] = []

    # -- transport ---------------------------------------------------------
    def _request(self, method: str, path: str, *, params: Optional[dict] = None,
                 body: Optional[dict] = None, raw: bool = False,
                 extra_headers: Optional[dict] = None,
                 retry_statuses: "tuple[int, ...]" = (429, 503)):
        url = self.base_url + path
        if params:
            params = {k: v for k, v in params.items() if v is not None}
            if params:
                url += "?" + urlencode(params, doseq=True)
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json",
                   "User-Agent": self._user_agent, "X-Diagrams-Client": self._client_id}
        if extra_headers:
            headers.update({k: v for k, v in extra_headers.items() if v is not None})
        data = None
        if body is not None:
            data = _json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        status, resp_headers, text = self._send_retrying(method, url, headers, data, retry_statuses)
        if raw:
            if status >= 400:
                self._raise(status, text)
            return text
        payload = _json.loads(text) if text else {}
        if status >= 400:
            err = (payload or {}).get("error") or {}
            raise DiagramsAPIError(err.get("code", "ERROR"), err.get("message", text or "request failed"),
                                   status, err.get("request_id"))
        return payload

    def _raise(self, status: int, text: str):
        try:
            err = (_json.loads(text) or {}).get("error") or {}
        except Exception:
            err = {}
        raise DiagramsAPIError(err.get("code", "ERROR"), err.get("message", text or "request failed"),
                               status, err.get("request_id"))

    def _send_retrying(self, method, url, headers, data, retry_statuses=(429, 503)):
        """Send with bounded retries on the given transient statuses (pre-processing
        rejections — rate limit / backpressure — so retrying never double-charges).
        Honors ``Retry-After``; otherwise exponential backoff. Billable calls pass
        ``(429,)`` so ``503`` is handled once by the idempotent ladder instead of
        being retried by both layers."""
        import time
        attempt = 0
        while True:
            status, resp_headers, text = self._send(method, url, headers, data)
            if status in retry_statuses and attempt < self.max_retries:
                ra = resp_headers.get("retry-after")
                delay = float(ra) if ra and ra.isdigit() else self.backoff * (2 ** attempt)
                time.sleep(min(delay, 30.0))
                attempt += 1
                continue
            return status, resp_headers, text

    def _send(self, method, url, headers, data):
        try:
            import requests  # type: ignore
        except ImportError:
            return self._send_urllib(method, url, headers, data)
        import requests.exceptions as _rex  # type: ignore
        try:
            r = requests.request(method, url, headers=headers, data=data, timeout=self.timeout)
        except _rex.Timeout as e:
            raise DiagramsAPIError("TIMEOUT",
                                   f"The Diagrams.so API did not respond within {self.timeout:g}s.", 0) from e
        except _rex.ConnectionError as e:
            raise DiagramsAPIError("CONNECTION_ERROR",
                                   f"Could not reach the Diagrams.so API at {self.base_url}. ({e})", 0) from e
        return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.text

    def _send_urllib(self, method, url, headers, data):
        import socket
        import urllib.error
        import urllib.request
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                return resp.getcode(), hdrs, resp.read().decode()
        except urllib.error.HTTPError as e:
            # A real HTTP response (4xx/5xx) — not an ambiguous transport failure.
            hdrs = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
            return e.code, hdrs, e.read().decode()
        except socket.timeout as e:
            raise DiagramsAPIError("TIMEOUT",
                                   f"The Diagrams.so API did not respond within {self.timeout:g}s.", 0) from e
        except urllib.error.URLError as e:
            # Timeout surfaced as URLError(reason=timeout), or a genuine connection failure.
            if isinstance(getattr(e, "reason", None), socket.timeout):
                raise DiagramsAPIError("TIMEOUT",
                                       f"The Diagrams.so API did not respond within {self.timeout:g}s.", 0) from e
            raise DiagramsAPIError("CONNECTION_ERROR",
                                   f"Could not reach the Diagrams.so API at {self.base_url}. ({e.reason})", 0) from e

    # -- session charge tally ---------------------------------------------
    def _track(self, action: str, result: Dict[str, Any]) -> Dict[str, Any]:
        """Record what a billable task charged, so ``session_charges`` can answer
        'how much did each task cost?' without a server round-trip. This counts only
        what THIS process saw; the server ledger (:meth:`usage_history`) is
        authoritative, and ambiguous outcomes go through :meth:`_track_unknown`."""
        try:
            usage = (result or {}).get("usage") or {}
            if usage:
                self.session_charges.append({
                    "action": action,
                    "status": "confirmed",
                    "diagram_id": (result or {}).get("id"),
                    "credits_charged": usage.get("credits_charged"),
                    "credits_remaining": usage.get("credits_remaining"),
                })
        except Exception:
            pass
        return result

    def _track_unknown(self, action: str, note: Optional[str] = None) -> None:
        """Record a billable call whose outcome this process never saw: the server
        may or may not have charged — only :meth:`usage_history` knows for sure."""
        self.session_charges.append({"action": action, "status": "unknown", "note": note})

    # -- billable calls: idempotency + bounded same-key retry --------------
    def _request_billable(self, method: str, path: str, *, action: str,
                          body: Optional[dict] = None, params: Optional[dict] = None,
                          idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Send a billable call with a fresh Idempotency-Key and bounded same-key
        retries on AMBIGUOUS failures (timeout / 5xx / in-progress). A response lost
        to a gateway timeout is REPLAYED by the server on retry — one charge, result
        recovered; retrying WITHOUT a key would create a second diagram and a second
        charge. Definite rejections (401/402/404/422 …) never retry. On final
        ambiguous failure the outcome is tallied as ``status:"unknown"`` and the
        error re-raised — reconcile against :meth:`usage_history`."""
        import time
        import uuid
        key = idempotency_key or str(uuid.uuid4())
        started = time.monotonic()
        last_err: Optional[Exception] = None
        for attempt in range(len(self.retry_delays) + 1):
            try:
                # retry_statuses=(429,): 503 is left to this idempotent ladder so it
                # isn't retried by both the inner Retry-After loop and here.
                return self._request(method, path, body=body, params=params,
                                     extra_headers={"Idempotency-Key": key},
                                     retry_statuses=(429,))
            except DiagramsAPIError as e:
                last_err = e
                if attempt == len(self.retry_delays) or not is_ambiguous(e):
                    break
                delay = self.retry_delays[attempt]
                if time.monotonic() - started + delay >= self.retry_budget:
                    break
                time.sleep(delay)
        if is_ambiguous(last_err):
            code = getattr(last_err, "code", "ERROR")
            self._track_unknown(action, note=f"{code} after retries — may have been charged")
        raise last_err  # type: ignore[misc]

    # -- diagrams ----------------------------------------------------------
    def generate(self, prompt: str, *, cloud_provider: str = "general",
                 diagram_type: str = "architecture", opinionated: bool = False,
                 idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._track("generate", self._request_billable(
            "POST", "/diagrams", action="generate",
            body={"prompt": prompt, "cloud_provider": cloud_provider,
                  "diagram_type": diagram_type, "opinionated": opinionated},
            idempotency_key=idempotency_key))

    def generate_stream(self, prompt: str, *, cloud_provider: str = "general",
                        diagram_type: str = "architecture", opinionated: bool = False,
                        idempotency_key: Optional[str] = None):
        """Stream a generation as Server-Sent Events. Yields ``(event, data)``
        tuples where ``event`` is ``"progress"`` | ``"complete"`` | ``"error"`` and
        ``data`` is the parsed JSON. Progress events carry only ``{stage, progress,
        message}`` — the diagram XML arrives ONLY in the terminal ``complete`` event
        (after the charge). Example::

            for event, data in client.generate_stream("AWS 3-tier app"):
                if event == "progress":
                    print(data["progress"], data["message"])
                elif event == "complete":
                    print(data["id"], data["usage"]["credits_charged"])
                elif event == "error":
                    raise RuntimeError(data["error"]["message"])
        """
        body = {"prompt": prompt, "cloud_provider": cloud_provider,
                "diagram_type": diagram_type, "opinionated": opinionated}
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "text/event-stream",
                   "Content-Type": "application/json",
                   "User-Agent": self._user_agent, "X-Diagrams-Client": self._client_id}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        data = _json.dumps(body).encode()
        url = self.base_url + "/diagrams/stream"
        for event, payload in self._sse(url, headers, data):
            if event == "complete":
                # A streamed generation is billable; the terminal event carries the
                # `usage` block, so record it as a confirmed charge (parity with the
                # non-streaming generate()).
                self._track("generate", payload)
            yield event, payload

    def _sse(self, url, headers, data):
        """Yield (event, parsed_data) from an SSE stream. Uses ``requests`` if
        available (true streaming), else buffers via ``urllib``."""
        try:
            import requests  # type: ignore
            with requests.post(url, headers=headers, data=data, stream=True, timeout=self.timeout) as r:
                if r.status_code >= 400:
                    self._raise(r.status_code, r.text)
                event, buf = None, []
                for raw in r.iter_lines(decode_unicode=True):
                    if raw is None:
                        continue
                    line = raw
                    if line == "":
                        if buf:
                            yield event or "message", _json.loads("".join(buf))
                        event, buf = None, []
                        continue
                    if line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: "):
                        buf.append(line[6:])
        except ImportError:
            import urllib.error
            import urllib.request
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            try:
                resp = urllib.request.urlopen(req, timeout=self.timeout)
            except urllib.error.HTTPError as e:
                self._raise(e.code, e.read().decode())
                return
            event, buf = None, []
            for bline in resp:
                line = bline.decode().rstrip("\n")
                if line == "":
                    if buf:
                        yield event or "message", _json.loads("".join(buf))
                    event, buf = None, []
                    continue
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    buf.append(line[6:])

    def get(self, diagram_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/diagrams/{diagram_id}")

    def list(self, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._request("GET", "/diagrams", params={"limit": limit, "cursor": cursor})

    def delete(self, diagram_id: str) -> None:
        self._request("DELETE", f"/diagrams/{diagram_id}", raw=True)

    def update(self, diagram_id: str, *, title: Optional[str] = None,
               is_public: Optional[bool] = None, xml: Optional[str] = None) -> Dict[str, Any]:
        return self._request("PATCH", f"/diagrams/{diagram_id}",
                             body={"title": title, "is_public": is_public, "xml": xml})

    def edit(self, diagram_id: str, edit_prompt: str, *,
             idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._track("edit", self._request_billable(
            "POST", f"/diagrams/{diagram_id}/edit", action="edit",
            body={"edit_prompt": edit_prompt}, idempotency_key=idempotency_key))

    def fix(self, diagram_id: str, message: str, *, component: Optional[str] = None,
            warning_type: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._track("fix", self._request_billable(
            "POST", f"/diagrams/{diagram_id}/fix", action="fix",
            body={"message": message, "component": component, "warning_type": warning_type},
            idempotency_key=idempotency_key))

    def warnings(self, diagram_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/diagrams/{diagram_id}/warnings")

    # -- async AI re-layout (202 + job_id; poll to completion) --------------
    def relayout(self, diagram_id: str, *, confirm: bool = False,
                 idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Start an async AI re-layout. Returns a job dict with ``job_id`` and
        ``status``. Re-layout is token-billed on **every** run (no free allowance):
        the API returns ``{"status": "confirmation_required"}`` until you re-call
        with ``confirm=True`` to accept the charge, which is applied only on delivery
        of the re-laid diagram (crash = no charge). Poll with :meth:`relayout_status`,
        or use :meth:`relayout_and_wait`."""
        return self._request_billable(
            "POST", f"/diagrams/{diagram_id}/relayout", action="relayout",
            params={"confirm": "true" if confirm else None},
            idempotency_key=idempotency_key)

    def relayout_status(self, diagram_id: str, job_id: str) -> Dict[str, Any]:
        """Poll a re-layout job. On ``status="done"`` with ``applied=True`` the
        result includes the re-laid ``xml`` + fresh ``warnings``/``score``."""
        return self._request("GET", f"/diagrams/{diagram_id}/relayout/{job_id}")

    def relayout_and_wait(self, diagram_id: str, *, confirm: bool = False,
                          poll_interval: float = 3.0, timeout: float = 300.0,
                          idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Convenience: start a re-layout and block until it reaches a terminal
        state (``done``/``failed``) or ``timeout`` seconds elapse. Returns the
        final status dict. If the API asks for confirmation, that dict is returned
        as-is (re-call with ``confirm=True``). If the poll budget expires the charge
        may still land on delivery, so it is recorded as ``status:"unknown"`` in
        ``session_charges`` before a TIMEOUT is raised — reconcile via
        :meth:`usage_history`."""
        import time
        started = self.relayout(diagram_id, confirm=confirm, idempotency_key=idempotency_key)
        if started.get("status") == "confirmation_required" or "job_id" not in started:
            return started
        job_id = started["job_id"]
        chargeable = started.get("chargeable")   # the server's verdict, echoed on start
        deadline = time.monotonic() + timeout
        recorded = False
        try:
            while True:
                st = self.relayout_status(diagram_id, job_id)
                if st.get("status") in ("done", "failed"):
                    if st.get("status") == "done" and chargeable:
                        # The re-layout charge bills asynchronously and isn't in the
                        # poll response, so the exact credits are unknown to this
                        # process — the ledger (usage_history) has them. Mirrors MCP.
                        self._track_unknown("relayout",
                                            note="chargeable re-layout applied; exact credits are in usage_history")
                        recorded = True
                    return st
                if time.monotonic() >= deadline:
                    if chargeable:
                        self._track_unknown("relayout",
                                            note="chargeable re-layout still running when the wait elapsed; check usage_history")
                        recorded = True
                    raise DiagramsAPIError("TIMEOUT", "re-layout did not finish in time", 0)
                time.sleep(poll_interval)
        except DiagramsAPIError:
            # A polling error leaves the outcome unknown: the job may still complete
            # and bill server-side. Record it once (unless already recorded above).
            if chargeable and not recorded:
                self._track_unknown("relayout",
                                    note="re-layout polling failed; the job may still complete and charge — check usage_history")
            raise

    def export(self, diagram_id: str, fmt: str = "drawio") -> str:
        """Return the raw diagram file (drawio XML or SVG)."""
        return self._request("GET", f"/diagrams/{diagram_id}/export", params={"format": fmt}, raw=True)

    def versions(self, diagram_id: str, *, limit: Optional[int] = None,
                 cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._request("GET", f"/diagrams/{diagram_id}/versions",
                             params={"limit": limit, "cursor": cursor})

    def get_version(self, diagram_id: str, version_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/diagrams/{diagram_id}/versions/{version_id}")

    def revert(self, diagram_id: str, *, version_id: Optional[str] = None,
               version_number: Optional[int] = None) -> Dict[str, Any]:
        return self._request("POST", f"/diagrams/{diagram_id}/revert",
                             body={"version_id": version_id, "version_number": version_number})

    def import_diagram(self, xml: str, *, title: Optional[str] = None,
                       cloud_provider: str = "general", diagram_type: str = "architecture") -> Dict[str, Any]:
        return self._request("POST", "/diagrams/import", body={
            "xml": xml, "title": title, "cloud_provider": cloud_provider, "diagram_type": diagram_type})

    # -- gallery -----------------------------------------------------------
    def search_gallery(self, *, q: Optional[str] = None, cloud_provider: Optional[str] = None,
                       diagram_type: Optional[str] = None, source: str = "all",
                       limit: Optional[int] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
        return self._request("GET", "/gallery", params={
            "q": q, "cloud_provider": cloud_provider, "diagram_type": diagram_type,
            "source": source, "limit": limit, "cursor": cursor})

    def fork(self, diagram_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/gallery/{diagram_id}/fork")

    # -- prompts -----------------------------------------------------------
    def enhance_prompt(self, prompt: str, *, cloud_provider: str = "general") -> Dict[str, Any]:
        return self._request("POST", "/prompts/enhance", body={"prompt": prompt, "cloud_provider": cloud_provider})

    def clarify_prompt(self, prompt: str) -> Dict[str, Any]:
        return self._request("POST", "/prompts/clarify", body={"prompt": prompt})

    # -- account -----------------------------------------------------------
    def usage(self) -> Dict[str, Any]:
        return self._request("GET", "/usage")

    def usage_history(self, *, limit: Optional[int] = None, cursor: Optional[str] = None,
                      action: Optional[List[str]] = None, source: Optional[List[str]] = None,
                      diagram_id: Optional[str] = None, livemode: Optional[bool] = None,
                      since: Optional[str] = None, until: Optional[str] = None,
                      include_grants: bool = False) -> Dict[str, Any]:
        """One page of the per-task credit-consumption history — how much each task
        (generate/edit/fix/relayout) charged, newest first. Returns
        ``{items, next_cursor, has_more, summary}``. ``action``/``source`` are lists;
        ``since``/``until`` are ISO-8601 bounds (map to the API's ``from``/``to``)."""
        params: Dict[str, Any] = {
            "limit": limit, "cursor": cursor, "diagram_id": diagram_id,
            "include_grants": "true" if include_grants else None,
            "from": since, "to": until,
        }
        if livemode is not None:
            params["livemode"] = "true" if livemode else "false"
        if action:
            params["action"] = action  # urlencode with doseq handles repeats
        if source:
            params["source"] = source
        return self._request("GET", "/usage/history", params=params)

    def iter_usage_history(self, **kwargs):
        """Yield every history item across pages, auto-following ``next_cursor``.
        Accepts the same filters as :meth:`usage_history` (except ``cursor``)."""
        kwargs.pop("cursor", None)
        cursor = None
        while True:
            page = self.usage_history(cursor=cursor, **kwargs)
            for item in page.get("items", []):
                yield item
            if not page.get("has_more"):
                return
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def me(self) -> Dict[str, Any]:
        return self._request("GET", "/me")

    def meta(self, kind: str) -> Any:
        """Supported values / your plan features.
        kind: 'diagram-types' | 'providers' | 'formats' | 'features'."""
        return self._request("GET", f"/meta/{kind}")
