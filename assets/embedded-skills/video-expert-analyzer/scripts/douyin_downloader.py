#!/usr/bin/env python3
"""
Compatibility adapter for pipeline_enhanced.py.
The project now ships download_douyin.py, while pipeline imports douyin_downloader.
This shim keeps the expected class interface.
"""

from pathlib import Path
import sys

_scripts_dir = Path(__file__).parent
if str(_scripts_dir) not in sys.path:
    sys.path.insert(0, str(_scripts_dir))

from download_douyin import (  # type: ignore
    is_douyin_url,
    get_redirect_url,
    extract_render_data,
    extract_video_url,
    download_douyin_video,
)


class DouyinDownloader:
    @staticmethod
    def is_douyin_url(url: str) -> bool:
        return bool(is_douyin_url(url))

    def get_redirect_url(self, url: str):
        result = get_redirect_url(url)
        if not isinstance(result, tuple):
            return None, None
        if len(result) >= 2:
            return result[0], result[1]
        return None, None

    def extract_render_data(self, html: str):
        return extract_render_data(html)

    def extract_video_url(self, data):
        return extract_video_url(data)

    def download(self, url: str, output_path) -> bool:
        return bool(download_douyin_video(url, str(output_path)))
