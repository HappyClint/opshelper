"""Check the user-authorized Ollama Cloud model without persisting its key."""
import datetime
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    key = os.environ.get("OLLAMA_API_KEY", "").strip()
    if not key:
        print("Missing OLLAMA_API_KEY; no request sent.")
        return 2
    report = {
        "date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "endpoint": "https://ollama.com/v1/chat/completions",
        "requestedModel": "gpt-oss:120b",
        "scope": "User-authorized model connection check; synthetic prompt only.",
        "status": "failed",
    }
    payload = {
        "model": "gpt-oss:120b",
        "messages": [{"role": "user", "content": "Reply with exactly OPSHELPER_OLLAMA_OK."}],
        "max_tokens": 512,
        "stream": False,
    }
    request = urllib.request.Request(report["endpoint"], data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            report["httpStatus"] = response.status
            data = json.loads(response.read(2 * 1024 * 1024))
        message = data.get("choices", [{}])[0].get("message", {})
        report["expectedReplyMatched"] = message.get("content", "").strip() == "OPSHELPER_OLLAMA_OK"
        report["returnedModelMatched"] = data.get("model") == "gpt-oss:120b"
        usage = data.get("usage", {})
        report["tokens"] = {k: v for k, v in usage.items()
            if k in ("prompt_tokens", "completion_tokens", "total_tokens") and isinstance(v, int)}
        if report["expectedReplyMatched"] and report["returnedModelMatched"]:
            report["status"] = "passed"
    except urllib.error.HTTPError as error:
        report["httpStatus"] = error.code
        report["errorCategory"] = "http_error"
    except Exception as error:
        report["errorCategory"] = type(error).__name__
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if key in serialized:
        raise RuntimeError("Secret redaction check failed")
    destination = Path(".temp/runtime-probes/ollama-connection.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(serialized)
    print(serialized)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
