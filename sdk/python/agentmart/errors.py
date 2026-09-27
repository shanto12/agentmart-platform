"""Exception types raised by the AgentMart client."""

from __future__ import annotations

from typing import Any, Mapping, Optional

__all__ = ["AgentMartError"]


class AgentMartError(Exception):
    """An error returned by the AgentMart API (or a transport failure).

    Attributes:
        code: machine-readable snake_case error code, e.g. ``insufficient_funds``.
              Transport failures use ``network_error``; undecodable bodies use
              ``invalid_response``.
        message: human-readable description.
        status: HTTP status code (0 when no response was received).
        request_id: value of the ``X-Request-Id`` header / error envelope, if any.
        body: the decoded response body, when available.
    """

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 0,
        request_id: Optional[str] = None,
        body: Optional[Any] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        super().__init__(f"[{status} {code}] {message}" + (f" (request_id={request_id})" if request_id else ""))
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id
        self.body = body
        self.headers = dict(headers or {})

    @property
    def retryable(self) -> bool:
        """True for rate limiting, server errors and transport failures."""
        return self.status == 429 or self.status >= 500 or self.status == 0

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return (
            f"AgentMartError(code={self.code!r}, message={self.message!r}, "
            f"status={self.status!r}, request_id={self.request_id!r})"
        )
