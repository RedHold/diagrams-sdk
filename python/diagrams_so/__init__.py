"""Diagrams.so Python SDK — a thin, typed client over the public /api/v2 REST API.

    from diagrams_so import DiagramsClient
    client = DiagramsClient(api_key="dgz_live_...")
    d = client.generate("AWS 3-tier web app", cloud_provider="aws")
    print(d["id"], d["score"]["score"])

Every method maps 1:1 to an endpoint. Errors raise DiagramsAPIError carrying the
API's error code, HTTP status, and request_id. Reads are free; generate/edit/fix/
fork cost credits.
"""

from .client import DiagramsAPIError, DiagramsClient

__all__ = ["DiagramsClient", "DiagramsAPIError"]
__version__ = "1.0.0"
