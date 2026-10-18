#!/usr/bin/env python3
"""
ساخت داده‌ی نسخه‌ی آزمایشی (دمو) در public/demo-data/

چرا؟ پوشه‌ی public/data فقط برای کاربران واردشده سرو می‌شود. کاربر بدون حساب (دمو)
به‌جای آن، نسخه‌ی کوچک‌شده از public/demo-data دریافت می‌کند، تا هیچ‌کس با باز کردن مستقیم
آدرس فایل‌ها کل دیتابیس را نگیرد.

قوانین دمو (همان قوانین داخل index.html، بخش demo-mode):
  - فقط دفترچه‌های ابنیه، مکانیک، برق
  - فقط فصل ۱ تا ۷
  - حدود ۳۰٪ ردیف‌ها (پخش‌شده در هر فصل)

هر بار فایل‌های public/data را عوض کردی، این اسکریپت را دوباره اجرا کن:
    python3 tools/make-demo-data.py
"""
import json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'data')
DST = os.path.join(ROOT, 'public', 'demo-data')

ALLOWED = {'ابنیه', 'مکانیک', 'برق'}
MAX_CHAPTER = 7
PCT = 30


def ch_num(c):
    s = re.sub(r'^0+(?=\d)', '', str(c if c is not None else ''))
    m = re.match(r'^[+-]?(\d+\.?\d*|\.\d+)', s)
    return float(m.group(0)) if m else 0.0


def ch_ok(c):
    return int(ch_num(c) // 1) <= MAX_CHAPTER


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def dump(obj, p):
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def filter_pricelist(arr):
    cnt, out = {}, []
    for x in arr:
        if not isinstance(x, dict):
            continue
        d = x.get('discipline')
        if d not in ALLOWED:
            continue
        if not ch_ok(x.get('chapter')):
            continue
        gk = '%s|%s|%s' % (x.get('year'), d, x.get('chapter'))
        n = cnt.get(gk, 0)
        cnt[gk] = n + 1
        if (n * PCT) % 100 < PCT:
            out.append(x)
    return out


def main():
    os.makedirs(DST, exist_ok=True)
    for old in glob.glob(os.path.join(DST, '*.json')):
        os.remove(old)

    codes = {}  # year -> set(code) از ردیف‌هایی که در دمو می‌مانند
    for p in sorted(glob.glob(os.path.join(SRC, 'pricelist-*.json'))):
        arr = load(p)
        out = filter_pricelist(arr)
        for x in out:
            codes.setdefault(str(x.get('year')), set()).add(str(x.get('code')))
        dump(out, os.path.join(DST, os.path.basename(p)))
        print('%-40s %6d -> %5d' % (os.path.basename(p), len(arr), len(out)))

    for p in sorted(glob.glob(os.path.join(SRC, 'analysis-1*-v*.json'))):
        name = os.path.basename(p)
        year = name.split('-')[1]
        keep = codes.get(year, set())
        d = load(p)
        out = {k: v for k, v in d.items() if k in keep and ch_ok(k[:2])}
        dump(out, os.path.join(DST, name))
        print('%-40s %6d -> %5d' % (name, len(d), len(out)))

    p = os.path.join(SRC, 'adjustment-index-v158.json')
    if os.path.exists(p):
        d = load(p)
        out = [r for r in d if len(r) >= 6 and r[5] in ALLOWED and ch_ok(r[0])]
        dump(out, os.path.join(DST, os.path.basename(p)))
        print('%-40s %6d -> %5d' % (os.path.basename(p), len(d), len(out)))


if __name__ == '__main__':
    sys.exit(main())
