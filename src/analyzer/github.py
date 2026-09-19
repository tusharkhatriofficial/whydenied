"""Minimal GitHub REST client using only the standard library."""

import base64
import json
import urllib.error
import urllib.request

API = "https://api.github.com"


class GitHubError(Exception):
    def __init__(self, status, message):
        super().__init__(f"GitHub {status}: {message}")
        self.status = status


class GitHub:
    def __init__(self, token, repo):
        self.token = token
        self.repo = repo  # "owner/name"

    def default_branch(self):
        return self._request("GET", f"/repos/{self.repo}")["default_branch"]

    def branch_sha(self, branch):
        return self._request("GET", f"/repos/{self.repo}/git/ref/heads/{branch}")["object"]["sha"]

    def tf_files(self, ref):
        """Return {path: content} for every .tf file at `ref`."""
        tree = self._request("GET", f"/repos/{self.repo}/git/trees/{ref}?recursive=1")
        files = {}
        for entry in tree.get("tree", []):
            if entry["type"] == "blob" and entry["path"].endswith(".tf"):
                blob = self._request("GET", f"/repos/{self.repo}/git/blobs/{entry['sha']}")
                files[entry["path"]] = base64.b64decode(blob["content"]).decode()
        return files

    def create_branch(self, name, sha):
        self._request("POST", f"/repos/{self.repo}/git/refs", {"ref": f"refs/heads/{name}", "sha": sha})

    def create_file(self, path, content, branch, message):
        self._request("PUT", f"/repos/{self.repo}/contents/{path}", {
            "message": message,
            "content": base64.b64encode(content.encode()).decode(),
            "branch": branch,
        })

    def open_pull_request(self, title, head, base, body):
        return self._request("POST", f"/repos/{self.repo}/pulls", {
            "title": title, "head": head, "base": base, "body": body,
        })["html_url"]

    def find_pull_request(self, head):
        owner = self.repo.split("/")[0]
        pulls = self._request("GET", f"/repos/{self.repo}/pulls?state=all&head={owner}:{head}")
        return pulls[0]["html_url"] if pulls else None

    def _request(self, method, path, body=None):
        req = urllib.request.Request(
            API + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "whydenied",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise GitHubError(e.code, detail) from None
