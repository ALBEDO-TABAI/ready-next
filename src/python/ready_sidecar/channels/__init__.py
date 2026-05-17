"""Ready sidecar channel adapters."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .manager import ChannelConfigModel, ChannelManager


def __getattr__(name: str):
    if name in {"ChannelManager", "ChannelConfigModel"}:
        from .manager import ChannelConfigModel, ChannelManager

        return {
            "ChannelManager": ChannelManager,
            "ChannelConfigModel": ChannelConfigModel,
        }[name]
    raise AttributeError(name)

__all__ = ["ChannelManager", "ChannelConfigModel"]
