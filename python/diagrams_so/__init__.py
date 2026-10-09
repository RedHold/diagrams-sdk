"""Diagrams.so Python SDK — a thin, typed client over the public /api/v2 REST API.

    from diagrams_so import DiagramsClient
    client = DiagramsClient(api_key="dgz_live_...")
    d = client.generate("AWS 3-tier web app", cloud_provider="aws")
    print(d["id"], d["score"]["score"])

Every method maps 1:1 to an endpoint. Errors raise DiagramsAPIError carrying the
API's error code, HTTP status, and request_id. Every plan has unlimited diagrams
and edits.
"""

from .auth import DiagramsAuthError, login, logout
from .client import DiagramsAPIError, DiagramsClient, is_ambiguous

__all__ = ["DiagramsClient", "DiagramsAPIError", "DiagramsAuthError",
           "is_ambiguous", "login", "logout"]
__version__ = "1.4.0"
