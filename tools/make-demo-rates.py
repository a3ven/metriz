#!/usr/bin/env python3
"""
ساخت جدول «نرخ عوامل» برای نسخه‌ی آزمایشی (دمو) در public/demo-data/

قوانین دمو:
  - همه‌ی سال‌ها
  - حداکثر ۲ دوره از هر سال (به‌صورت تصادفی)
  - از هر سال ۵ گروه (تصادفی؛ برای هر دو دوره‌ی آن سال یکسان)
  - ۵۰٪ ردیف‌های (عوامل) هر گروه
  - در هر ردیف فقط یکی از «حداقل / حداکثر / متوسط» (تصادفی) می‌ماند؛ دو تای دیگر خالی (—)
اجرا (فقط فایل‌های rates-* را می‌سازد و به بقیه‌ی demo-data دست نمی‌زند):
    python3 tools/make-demo-rates.py
"""
import glob, json, os, random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'data')
DST = os.path.join(ROOT, 'public', 'demo-data')
SEED = 1405
GROUPS_PER_YEAR = 5
PERIODS_PER_YEAR = 2


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def dump(obj, p):
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def main():
    rnd = random.Random(SEED)
    os.makedirs(DST, exist_ok=True)
    for old in glob.glob(os.path.join(DST, 'rates-*.json')):
        os.remove(old)
    idx = load(os.path.join(SRC, 'rates-index-v1.json'))
    out_years = []
    for Y in idx['years']:
        periods = Y['p']
        if len(periods) > PERIODS_PER_YEAR:
            pick = set(p['k'] for p in rnd.sample(periods, PERIODS_PER_YEAR))
            periods = [p for p in periods if p['k'] in pick]
        files = {p['k']: load(os.path.join(SRC, p['f'])) for p in periods}
        # گروه‌هایی که در همه‌ی دوره‌های انتخاب‌شده‌ی این سال هستند
        common = None
        for F in files.values():
            names = [g['n'] for g in F['g']]
            common = names if common is None else [n for n in common if n in names]
        chosen = set(rnd.sample(common, min(GROUPS_PER_YEAR, len(common))))
        # تصمیم تصادفی ردیف‌ها و ستون باقی‌مانده یک‌بار برای هر ردیف (در دوره‌ها یکسان نیست؛ مستقل)
        out_p = []
        for p in periods:
            F = files[p['k']]
            groups = []
            for g in F['g']:
                if g['n'] not in chosen:
                    continue
                rows = g['r']
                keep_n = max(1, round(len(rows) * 0.5))
                keep = sorted(rnd.sample(range(len(rows)), keep_n))
                new_rows = []
                for i in keep:
                    r = list(rows[i])
                    c = rnd.choice([2, 3, 4])  # حداقل / حداکثر / متوسط
                    for j in (2, 3, 4):
                        if j != c:
                            r[j] = None
                    new_rows.append(r)
                ng = dict(g)
                ng['r'] = new_rows
                groups.append(ng)
            out = {k: v for k, v in F.items() if k != 'g'}
            out['g'] = groups
            dump(out, os.path.join(DST, p['f']))
            out_p.append(dict(p, g=len(groups), n=sum(len(g['r']) for g in groups)))
        out_years.append({'y': Y['y'], 'p': out_p})
        print(Y['y'], [p['k'] for p in out_p], len(chosen), 'groups')
    dump({'v': idx.get('v', 1), 'years': out_years}, os.path.join(DST, 'rates-index-v1.json'))


if __name__ == '__main__':
    main()
