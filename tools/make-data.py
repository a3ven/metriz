#!/usr/bin/env python3
"""
ساخت تکه‌های داده (shard) و نسخه‌ی دمو

ورودی  : فایل‌های اصلی  public/data/pricelist-*.json  (همان‌هایی که الان داری، دست‌نخورده می‌مانند)
خروجی  :
  public/data/shard-index.json         فهرست تکه‌ها (سال، دفترچه، نام فایل، تعداد ردیف)
  public/data/shard-<سال>-<NN>.json    هر تکه = همه‌ی ردیف‌های یک سال و یک دفترچه
  public/demo-data/...                 نسخه‌ی کوچک‌شده برای کاربر آزمایشی (دمو)

سرور فقط همین تکه‌ها را (با سقف روزانه/هفتگی) به کاربر می‌دهد؛ خود فایل‌های pricelist-*.json
دیگر از بیرون قابل دریافت نیستند.

هر بار فایل‌های public/data را عوض کردی، دوباره اجرا کن:
    python tools/make-data.py

قوانین دمو (همان قوانین index.html، بخش demo-mode):
  فقط دفترچه‌های ابنیه، مکانیک، برق — فقط فصل ۱ تا ۷ — حدود ۳۰٪ ردیف‌ها
"""
import json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'data')
DST = os.path.join(ROOT, 'public', 'demo-data')

ALLOWED = {'ابنیه', 'مکانیک', 'برق'}
MAX_CHAPTER = 7
PCT = 30

# ترتیب خواندن فایل‌ها = ترتیب بارگذاری قدیمی برنامه
ORDER = (['pricelist-v160.json', 'pricelist-1398-v1.json']
         + ['pricelist-%s-lists-v1.json' % y for y in ('1397', '1399', '1400', '1401', '1402', '1403', '1404')]
         + ['pricelist-%s-lists2-v1.json' % y for y in ('1397', '1398', '1399', '1400', '1401', '1402', '1403', '1404')])


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


def demo_filter(arr):
    cnt, out = {}, []
    for x in arr:
        if x.get('discipline') not in ALLOWED or not ch_ok(x.get('chapter')):
            continue
        gk = '%s|%s|%s' % (x.get('year'), x.get('discipline'), x.get('chapter'))
        n = cnt.get(gk, 0)
        cnt[gk] = n + 1
        if (n * PCT) % 100 < PCT:
            out.append(x)
    return out


def main():
    # ---- 1) گروه‌بندی بر اساس سال × دفترچه
    groups = {}   # (year, disc) -> [rows]
    seen_order = []
    for name in ORDER:
        p = os.path.join(SRC, name)
        if not os.path.exists(p):
            print('هشدار: فایل پیدا نشد:', name)
            continue
        for x in load(p):
            if not isinstance(x, dict):
                continue
            k = (str(x.get('year')), x.get('discipline'))
            if k not in groups:
                groups[k] = []
                seen_order.append(k)
            groups[k].append(x)

    # ---- 2) پاک‌سازی خروجی‌های قبلی
    for old in glob.glob(os.path.join(SRC, 'shard-*.json')):
        os.remove(old)
    os.makedirs(DST, exist_ok=True)
    for old in glob.glob(os.path.join(DST, '*.json')):
        os.remove(old)

    # ---- 3) نوشتن تکه‌ها
    per_year = {}
    index, demo_index, demo_codes = [], [], {}
    for k in seen_order:
        y, d = k
        per_year[y] = per_year.get(y, 0) + 1
        fname = 'shard-%s-%02d.json' % (y, per_year[y])
        rows = groups[k]
        dump(rows, os.path.join(SRC, fname))
        index.append({'y': y, 'd': d, 'f': fname, 'n': len(rows)})
        drows = demo_filter(rows)
        if drows:
            dump(drows, os.path.join(DST, fname))
            demo_index.append({'y': y, 'd': d, 'f': fname, 'n': len(drows)})
            demo_codes.setdefault(y, set()).update(str(r.get('code')) for r in drows)
    dump({'v': 1, 'shards': index}, os.path.join(SRC, 'shard-index.json'))
    dump({'v': 1, 'shards': demo_index}, os.path.join(DST, 'shard-index.json'))
    print('تکه‌ها: %d  | تکه‌های دمو: %d' % (len(index), len(demo_index)))

    # ---- 4) آنالیزها (دمو): فقط کدهایی که در تکه‌های دمو هستند
    for p in sorted(glob.glob(os.path.join(SRC, 'analysis-1*-v*.json'))):
        name = os.path.basename(p)
        year = name.split('-')[1]
        keep = demo_codes.get(year, set())
        d = load(p)
        out = {c: v for c, v in d.items() if c in keep and ch_ok(c[:2])}
        dump(out, os.path.join(DST, name))

    # ---- 5) شاخص تعدیل (دمو)
    p = os.path.join(SRC, 'adjustment-index-v158.json')
    if os.path.exists(p):
        d = load(p)
        dump([r for r in d if len(r) >= 6 and r[5] in ALLOWED and ch_ok(r[0])],
             os.path.join(DST, os.path.basename(p)))
    print('تمام شد.')


if __name__ == '__main__':
    sys.exit(main())
