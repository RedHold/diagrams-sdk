"""Command line interface for the Diagrams.so Python SDK.

Installing the package puts a `diagrams-so` command on your PATH, so a Python
user can connect without writing any code and without needing Node:

    pip install diagrams-so
    diagrams-so login

The credential it stores is the same file the MCP server and the TypeScript SDK
read, so connecting once with any of them connects all of them on that machine.
"""
from __future__ import annotations

import sys
from typing import List, Optional

from . import __version__
from .auth import DiagramsAuthError, credentials_path, load_cached_api_key, login, logout
from .client import DEFAULT_BASE, DiagramsAPIError, DiagramsClient

USAGE = """diagrams-so {version}

Usage:
  diagrams-so login [--test] [--base-url URL] [--no-browser]
  diagrams-so logout
  diagrams-so whoami [--base-url URL]

Commands:
  login     Connect this machine. A browser opens; approve the request there.
  logout    Remove the stored credential from this machine.
  whoami    Show which account this machine is connected as.

Options:
  --test        Mint a test-mode key. Test keys act on your real account.
  --base-url    Point at a different API (default {base}).
  --no-browser  Do not open a browser; the URL is printed for you to open.
""".strip()


def _flag(args: List[str], name: str) -> bool:
    if name in args:
        args.remove(name)
        return True
    return False


def _opt(args: List[str], name: str) -> Optional[str]:
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            raise SystemExit(f"{name} requires a value")
        value = args[i + 1]
        del args[i : i + 2]
        return value
    return None


def _resolve_base(args: List[str]) -> str:
    return _opt(args, "--base-url") or DEFAULT_BASE


def _cmd_login(args: List[str]) -> int:
    test = _flag(args, "--test")
    no_browser = _flag(args, "--no-browser")
    base = _resolve_base(args)
    if args:
        print(f"Unknown option: {args[0]}", file=sys.stderr)
        return 1
    try:
        client = login(test=test, base_url=base, open_browser=not no_browser)
    except DiagramsAuthError as e:
        print(str(e), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130
    try:
        me = client.me()
        mode = "live" if me.get("livemode", True) else "test"
        print(f"Connected as {me.get('email', 'unknown')} ({mode}).")
    except DiagramsAPIError:
        pass  # login() already confirmed and printed where the credential went
    return 0


def _cmd_logout(args: List[str]) -> int:
    if args:
        print(f"Unknown option: {args[0]}", file=sys.stderr)
        return 1
    logout()
    print("Disconnected. The stored credential has been removed.")
    return 0


def _cmd_whoami(args: List[str]) -> int:
    base = _resolve_base(args)
    if args:
        print(f"Unknown option: {args[0]}", file=sys.stderr)
        return 1
    import os

    env_key = os.environ.get("DIAGRAMS_API_KEY")
    key = env_key or load_cached_api_key(base)
    if not key:
        print(
            "Not connected. Run `diagrams-so login` (or set DIAGRAMS_API_KEY).",
            file=sys.stderr,
        )
        return 1
    try:
        me = DiagramsClient(api_key=key, base_url=base).me()
    except DiagramsAPIError as e:
        if e.status == 401:
            print(
                "Session credential expired or revoked. Run `diagrams-so login` again.",
                file=sys.stderr,
            )
        else:
            print(f"Could not verify the credential against {base}: {e}", file=sys.stderr)
        return 1
    mode = "live" if me.get("livemode", True) else "test"
    print(f"Connected as {me.get('email', 'unknown')} ({mode}).")
    print(
        "Credential source: "
        + ("env (DIAGRAMS_API_KEY)" if env_key else f"login ({credentials_path()})")
    )
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(USAGE.format(version=__version__, base=DEFAULT_BASE))
        return 0
    if args[0] in ("-V", "--version", "version"):
        print(__version__)
        return 0

    command, rest = args[0], args[1:]
    if command == "login":
        return _cmd_login(rest)
    if command == "logout":
        return _cmd_logout(rest)
    if command == "whoami":
        return _cmd_whoami(rest)

    print(f"Unknown command: {command}\n", file=sys.stderr)
    print(USAGE.format(version=__version__, base=DEFAULT_BASE), file=sys.stderr)
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
