#!/usr/bin/env python3
"""One bounded, browser-fingerprinted GET for the shared News fetcher."""

import json
import sys
from urllib.parse import urlsplit


MAX_HEADER_BYTES = 65_536
MAX_BODY_BYTES = 8_000_000
ALLOWED_DOMAINS = ("apnews.com", "axios.com", "investing.com", "crowdfundinsider.com")


def main():
    from curl_cffi import CurlOpt, requests

    url, timeout_ms, max_body_bytes, max_decoded_bytes, accept, early_stop = sys.argv[1:]
    max_body_bytes = int(max_body_bytes)
    max_decoded_bytes = int(max_decoded_bytes)
    if not 0 < max_body_bytes <= MAX_BODY_BYTES or not 0 < max_decoded_bytes <= MAX_BODY_BYTES:
        raise ValueError("News HTTP body limits are outside policy")
    if early_stop not in ("0", "1"):
        raise ValueError("Invalid News HTTP early-stop setting")
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or not any(hostname == domain or hostname.endswith("." + domain) for domain in ALLOWED_DOMAINS)
    ):
        raise ValueError("News HTTP retry URL is outside its publisher policy")

    with requests.Session(curl_options={CurlOpt.MAXFILESIZE_LARGE: max_body_bytes}) as session:
        response = session.get(
            url,
            impersonate="chrome",
            headers={"Accept": accept},
            allow_redirects=False,
            stream=True,
            timeout=int(timeout_ms) / 1000,
        )
        try:
            header_bytes = sum(len(key.encode()) + len(value.encode()) + 4 for key, value in response.headers.items())
            if header_bytes > MAX_HEADER_BYTES:
                raise ValueError("HTTP response headers exceeded 65536 bytes")
            length = response.headers.get("content-length")
            if length and length.isdigit() and int(length) > max_body_bytes:
                raise ValueError("HTTP response body exceeded compressed-byte limit")

            metadata = {
                "status": response.status_code,
                "headers": {
                    "content-type": response.headers.get("content-type", ""),
                    "location": response.headers.get("location", ""),
                },
            }
            sys.stdout.buffer.write(json.dumps(metadata, separators=(",", ":")).encode() + b"\n")
            sys.stdout.buffer.flush()
            if not 200 <= response.status_code < 300:
                return

            decoded_bytes = 0
            for chunk in response.iter_content():
                remaining = max_decoded_bytes - decoded_bytes
                if len(chunk) > remaining and early_stop == "0":
                    raise ValueError("News HTTP response exceeded decoded-body limit")
                accepted = chunk[:remaining]
                sys.stdout.buffer.write(accepted)
                sys.stdout.buffer.flush()
                decoded_bytes += len(accepted)
                if decoded_bytes >= max_decoded_bytes and early_stop == "1":
                    break
        finally:
            response.close()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass  # The News fetcher already found enough article text and closed the pipe.
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
