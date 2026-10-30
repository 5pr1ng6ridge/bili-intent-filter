"""插件 HTTP 打分接口的示例服务（只用标准库）。

运行：python server/score_server.py [--port 8765]
插件里选择“外部模型”，地址填 http://127.0.0.1:8765/score

接入 jev 或其他决策模型时，只需要改 score_items()：
输入意图、排除词和视频列表，返回 {BV号: 0~1 分数}。
"""

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def split_phrases(text):
    return [p.strip().lower() for p in re.split(r"[,，、;；\n|]+", text or "") if p.strip()]


def grams(text):
    s = (text or "").lower()
    out = set(re.findall(r"[a-z0-9]+", s))
    for run in re.findall(r"[㐀-鿿]+", s):
        if len(run) == 1:
            out.add(run)
        out.update(run[i : i + 2] for i in range(len(run) - 1))
    return out


def coverage(phrase, text_grams):
    g = grams(phrase)
    return sum(x in text_grams for x in g) / len(g) if g else 0.0


def score_items(intent, exclude, items):
    """在这里替换成真正的决策模型。当前是和插件内置基线相同的字面匹配。

    插件每次只填 intent 和 exclude 中的一个（多选模式时每个“想看”单独调用一次），
    这里仍按两者都可能有值来写，方便手动测试。
    """
    intents, excludes = split_phrases(intent), split_phrases(exclude)
    scores = {}
    for item in items:
        tags = " ".join(item.get("tags") or [])
        tg = grams(f"{item.get('title', '')} {item.get('up', '')} {item.get('sub', '')} {tags}")
        pos = max((coverage(p, tg) for p in intents), default=1.0)
        neg = max((coverage(p, tg) for p in excludes), default=0.0)
        scores[item["id"]] = round(pos * (1 - neg), 3)
    return scores


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        if self.path != "/score":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            scores = score_items(req.get("intent", ""), req.get("exclude", ""), req.get("items", []))
        except Exception as e:  # 示例服务：把错误原样返回给插件，方便在角标上看到
            return self._send(400, {"error": str(e)})
        for item in req.get("items", []):
            print(f"{scores.get(item['id'], '-'):>6}  {item.get('title', '')}", flush=True)
        self._send(200, {"scores": scores})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    print(f"打分服务已启动：http://127.0.0.1:{args.port}/score")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
