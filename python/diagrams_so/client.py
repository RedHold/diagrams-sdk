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


class DiagramsClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE, timeout: float = 120.0,
                 max_retries: int = 3, backoff: float = 0.5):
        if not api_key:
            raise ValueError("api_key is required (dgz_live_… or dgz_test_…)")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff = backoff

    # -- transport ---------------------------------------------------------
    def _request(self, method: str, path: str, *, params: Optional[dict] = None,
                 body: Optional[dict] = None, raw: bool = False,
                 extra_headers: Optional[dict] = None):
        url = self.base_url + path
        if params:
            params = {k: v for k, v in params.items() if v is not None}
            if params:
                url += "?" + urlencode(params)
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
        if extra_headers:
            headers.update({k: v for k, v in extra_headers.items() if v is not None})
        data = None
        if body is not None:
            data = _json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        status, resp_headers, text = self._send_retrying(method, url, headers, data)
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

    def _send_retrying(self, method, url, headers, data):
        """Send with bounded retries on 429/503 only. Those are pre-processing
        rejections (rate limit / backpressure), so retrying never double-charges a
        billable op. Honors ``Retry-After``; otherwise exponential backoff."""
        import time
        attempt = 0
        while True:
            status, resp_headers, text = self._send(method, url, headers, data)
            if status in (429, 503) and attempt < self.max_retries:
                ra = resp_headers.get("retry-after")
                delay = float(ra) if ra and ra.isdigit() else self.backoff * (2 ** attempt)
                time.sleep(min(delay, 30.0))
                attempt += 1
                continue
            return status, resp_headers, text

    def _send(self, method, url, headers, data):
        try:
            import requests  # type: ignore
            r = requests.request(method, url, headers=headers, data=data, timeout=self.timeout)
            return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.text
        except ImportError:
            import urllib.error
            import urllib.request
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    hdrs = {k.lower(): v for k, v in resp.headers.items()}
                    return resp.getcode(), hdrs, resp.read().decode()
            except urllib.error.HTTPError as e:
                hdrs = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
                return e.code, hdrs, e.read().decode()

    # -- diagrams ----------------------------------------------------------
    def generate(self, prompt: str, *, cloud_provider: str = "general",
                 diagram_type: str = "architecture", opinionated: bool = False,
                 idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._request("POST", "/diagrams", body={
            "prompt": prompt, "cloud_provider": cloud_provider,
            "diagram_type": diagram_type, "opinionated": opinionated,
        }, extra_headers={"Idempotency-Key": idempotency_key})

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
                   "Content-Type": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        data = _json.dumps(body).encode()
        url = self.base_url + "/diagrams/stream"
        for event, payload in self._sse(url, headers, data):
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
        return self._request("POST", f"/diagrams/{diagram_id}/edit", body={"edit_prompt": edit_prompt},
                             extra_headers={"Idempotency-Key": idempotency_key})

    def fix(self, diagram_id: str, message: str, *, component: Optional[str] = None,
            warning_type: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._request("POST", f"/diagrams/{diagram_id}/fix",
                             body={"message": message, "component": component, "warning_type": warning_type},
                             extra_headers={"Idempotency-Key": idempotency_key})

    def warnings(self, diagram_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/diagrams/{diagram_id}/warnings")

    # -- async AI re-layout (202 + job_id; poll to completion) --------------
    def relayout(self, diagram_id: str, *, confirm: bool = False) -> Dict[str, Any]:
        """Start an async AI re-layout. Returns a job dict with ``job_id`` and
        ``status``. The first re-layouts per diagram are free; once exhausted the
        API returns ``{"status": "confirmation_required"}`` — re-call with
        ``confirm=True`` to accept the (credit) charge. Poll with
        :meth:`relayout_status`, or use :meth:`relayout_and_wait`."""
        return self._request("POST", f"/diagrams/{diagram_id}/relayout",
                             params={"confirm": "true" if confirm else None})

    def relayout_status(self, diagram_id: str, job_id: str) -> Dict[str, Any]:
        """Poll a re-layout job. On ``status="done"`` with ``applied=True`` the
        result includes the re-laid ``xml`` + fresh ``warnings``/``score``."""
        return self._request("GET", f"/diagrams/{diagram_id}/relayout/{job_id}")

    def relayout_and_wait(self, diagram_id: str, *, confirm: bool = False,
                          poll_interval: float = 3.0, timeout: float = 300.0) -> Dict[str, Any]:
        """Convenience: start a re-layout and block until it reaches a terminal
        state (``done``/``failed``) or ``timeout`` seconds elapse. Returns the
        final status dict. If the API asks for confirmation, that dict is returned
        as-is (re-call with ``confirm=True``)."""
        import time
        started = self.relayout(diagram_id, confirm=confirm)
        if started.get("status") == "confirmation_required" or "job_id" not in started:
            return started
        job_id = started["job_id"]
        deadline = time.monotonic() + timeout
        while True:
            st = self.relayout_status(diagram_id, job_id)
            if st.get("status") in ("done", "failed"):
                return st
            if time.monotonic() >= deadline:
                raise DiagramsAPIError("TIMEOUT", "re-layout did not finish in time", 0)
            time.sleep(poll_interval)

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

    def me(self) -> Dict[str, Any]:
        return self._request("GET", "/me")

    def meta(self, kind: str) -> Any:
        """Supported values / your plan features.
        kind: 'diagram-types' | 'providers' | 'formats' | 'features'."""
        return self._request("GET", f"/meta/{kind}")
