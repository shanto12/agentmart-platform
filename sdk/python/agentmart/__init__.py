"""AgentMart Python SDK — a tiny, dependency-free client for the AgentMart v1 API.

    from agentmart import AgentMart, AgentMartError
    am = AgentMart(api_key="am_live_...")
"""

__version__ = "1.1.0"

from .errors import AgentMartError  # noqa: E402
from .client import DEFAULT_BASE_URL, AgentMart, unwrap  # noqa: E402

__all__ = ["AgentMart", "AgentMartError", "DEFAULT_BASE_URL", "unwrap", "__version__"]
