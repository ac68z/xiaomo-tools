# 开画.py —— 作画的闸门（2026-11-09 主人定）
#
#   python draw\open_draw.py            # 打印守则全文 → 再把 sha256 前 8 位给你 → 输回去才开
#   python draw\open_draw.py --status   # 看现在开没开、还有多久
#   python draw\open_draw.py --close    # 现在关上
#
# 有效期默认 2 小时（主人 11-09 21:3x 改：四小时还是太长，两小时差不多）。
# 想改时长：--hours 48

import argparse
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = os.path.join(HERE, 'rules.txt')
STATE = os.path.join(HERE, '.draw-open.json')


def token():
    with open(RULES, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]


def status():
    try:
        with open(STATE, 'r', encoding='utf-8') as f:
            s = json.load(f)
    except Exception:
        print('没开画。')
        return
    left = (s.get('expiresAt', 0) / 1000) - time.time()
    if left <= 0:
        print('开过，但已经过期。')
    else:
        print('已开画，还剩 %.1f 小时（到期：%s）。' % (
            left / 3600, time.strftime('%Y-%m-%d %H:%M', time.localtime(s['expiresAt'] / 1000))))
    if s.get('token') != token():
        print('注意：守则改过了，这个通行码作废。')


def close():
    if os.path.exists(STATE):
        os.remove(STATE)
        print('已关上。下次要重读守则。')
    else:
        print('本来就没开。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--status', action='store_true')
    ap.add_argument('--close', action='store_true')
    ap.add_argument('--hours', type=float, default=2)
    a = ap.parse_args()
    if a.status:
        return status()
    if a.close:
        return close()

    with open(RULES, 'r', encoding='utf-8') as f:
        body = f.read()
    print('================ 作画守则 ================')
    print(body)
    print('==========================================')
    real = token()
    print('\n读完了。把下面的码原样打回来（这是这道门的唯一意义：证明我读到底了）：')
    print('    码：%s\n' % real)
    try:
        got = input('输入：').strip()
    except EOFError:
        print('没输入，不算开画。')
        return 1
    if got != real:
        print('不对，没开。回去把守则重读一遍。')
        return 1
    exp = time.time() + a.hours * 3600
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump({'token': real, 'openedAt': int(time.time() * 1000),
                   'expiresAt': int(exp * 1000)}, f, ensure_ascii=False)
    print('开画了，有效期 %.0f 小时（到 %s）。' % (a.hours, time.strftime('%Y-%m-%d %H:%M', time.localtime(exp))))
    return 0


if __name__ == '__main__':
    sys.exit(main())


