#!/usr/bin/env python3
"""
ساخت داده‌ی «نرخ عوامل» (دستمزد ساعتی نیروی انسانی — مرکز آمار ایران) از فایل‌های اکسل.

استفاده:
    python3 tools/make-rates.py <پوشه‌ی اکسل‌ها> [پوشه‌ی خروجی = public/data]

هر فایل اکسل می‌تواند یک یا چند دوره داشته باشد (مثلاً «نیمه دوم + کل سال»).
دوره‌ها از «عنوان هر جدول» (سلول A1 هر شیت) خوانده می‌شود، نه از نام فایل.

خروجی:
    rates-index-v1.json              فهرست سال‌ها و دوره‌ها
    rates-<سال>-<دوره>-v1.json       گروه‌ها و ردیف‌های هر دوره
    دوره: h1 نیمه اول | h2 نیمه دوم | q1..q4 بهار..زمستان | y کل سال

ردیف هر نیرو: [نام قلم, واحد, حداقل, حداکثر, متوسط]   (ریال برای یک ساعت)
"""
import glob
import json
import os
import re
import sys
import warnings

warnings.filterwarnings('ignore')
import openpyxl  # noqa: E402

VER = 1
PERIODS = {  # کلید: (عنوان, ترتیب)
    'h1': ('نیمه اول', 1), 'q1': ('بهار', 2), 'q2': ('تابستان', 3),
    'h2': ('نیمه دوم', 4), 'q3': ('پاییز', 5), 'q4': ('زمستان', 6), 'y': ('کل سال', 9),
}


def norm(s):
    """یکدست‌سازی حروف عربی/فارسی و فاصله‌ها (نیم‌فاصله حفظ می‌شود)."""
    if s is None:
        return ''
    s = str(s).replace('ي', 'ی').replace('ك', 'ک').replace('ى', 'ی').replace('‏', '').replace('‎', '')
    s = re.sub(r'[ \t\r\n\xa0]+', ' ', s)
    s = re.sub(r' ?‌ ?', '‌', s)
    return s.strip()


def squash(s):
    return norm(s).replace('‌', '').replace(' ', '')


def period_of(label):
    q = squash(label)
    ym = re.search(r'(1[3-4]\d\d)', q)
    if not ym:
        return None
    year = ym.group(1)
    if 'نیمهاول' in q:
        return year, 'h1'
    if 'نیمهدوم' in q:
        return year, 'h2'
    for k, w in (('q1', 'بهار'), ('q2', 'تابستان'), ('q3', 'پاییز'), ('q4', 'زمستان')):
        if w in q:
            return year, k
    if q.startswith('سال'):
        return year, 'y'
    return None


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else round(float(v), 2)
    return None


def parse_sheet(ws, order):
    title = norm(ws['A1'].value)
    m = re.match(r'^جدول\s*(\d+)\s*[-–]\s*(.*)$', title)
    if not m:
        return None
    no = order  # ترتیب شیت (شماره‌ی داخل عنوان گاهی تکراری/اشتباه است)
    rest = m.group(2)
    # عنوان گروه و دوره: «... منتخب گروه <گروه>: <دوره>»
    parts = re.split(r'\s*:\s*', rest)
    label = parts[-1]
    head = ':'.join(parts[:-1]) if len(parts) > 1 else rest
    gm = re.search(r'منتخب\s+(?:گروه\s+)?(?:گروه\s+)?(.+)$', head)
    group = norm(gm.group(1) if gm else head)
    per = period_of(label)
    if not per:
        return None

    # ستون‌های حداقل/حداکثر/متوسط
    cols = {}
    hdr_row = None
    for r in range(1, 6):
        for c in range(1, ws.max_column + 1):
            t = squash(ws.cell(r, c).value)
            if t in ('حداقل', 'حداکثر', 'متوسط') and t not in cols:
                cols[t] = c
                hdr_row = r
    if len(cols) < 3:
        return None
    # ستون واحد (متنی مثل «یک ساعت») کنار نام قلم
    rows = []
    skipped = []
    for r in range(hdr_row + 1, ws.max_row + 1):
        name = norm(ws.cell(r, 1).value)
        if not name:
            continue
        vals = [num(ws.cell(r, cols[k]).value) for k in ('حداقل', 'حداکثر', 'متوسط')]
        if all(v is None for v in vals):
            skipped.append((r, name))
            continue
        unit = ''
        for c in range(2, min(cols.values())):
            t = norm(ws.cell(r, c).value)
            if t:
                unit = t
                break
        rows.append([name, unit or 'یک ساعت'] + vals)
    return {'year': per[0], 'key': per[1], 'no': no, 'group': group, 'rows': rows, 'skipped': skipped}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'data')
    os.makedirs(out, exist_ok=True)

    store = {}  # (year,key) -> {no: group dict}
    problems = []
    for f in sorted(glob.glob(os.path.join(src, '*.xlsx'))):
        wb = openpyxl.load_workbook(f, data_only=True)
        for ws in wb.worksheets:
            if not ws.title.strip().isdigit():
                continue
            try:
                g = parse_sheet(ws, int(ws.title.strip()))
            except Exception as e:  # noqa: BLE001
                problems.append('%s [%s]: %s' % (os.path.basename(f), ws.title, e))
                continue
            if not g:
                problems.append('%s [%s]: شیت خوانده نشد' % (os.path.basename(f), ws.title))
                continue
            if not g['rows']:
                problems.append('%s [%s]: بدون ردیف' % (os.path.basename(f), ws.title))
                continue
            for r, n in g['skipped']:
                problems.append('%s [%s] ردیف %d «%s»: بدون عدد، رد شد' % (os.path.basename(f), ws.title, r, n))
            d = store.setdefault((g['year'], g['key']), {})
            if g['no'] in d:
                problems.append('%s [%s]: جدول %d تکراری' % (os.path.basename(f), ws.title, g['no']))
            d[g['no']] = g

    years = {}
    for (y, k), tabs in store.items():
        groups = [{'n': t['group'], 'no': t['no'], 'r': t['rows']} for _, t in sorted(tabs.items())]
        fn = 'rates-%s-%s-v%d.json' % (y, k, VER)
        with open(os.path.join(out, fn), 'w', encoding='utf-8') as fh:
            json.dump({'y': y, 'k': k, 't': PERIODS[k][0], 'g': groups}, fh, ensure_ascii=False, separators=(',', ':'))
        years.setdefault(y, []).append({'k': k, 't': PERIODS[k][0], 'f': fn, 'g': len(groups), 'n': sum(len(g['r']) for g in groups)})
    idx = {'v': VER, 'years': [{'y': y, 'p': sorted(ps, key=lambda p: PERIODS[p['k']][1])} for y, ps in sorted(years.items(), reverse=True)]}
    with open(os.path.join(out, 'rates-index-v%d.json' % VER), 'w', encoding='utf-8') as fh:
        json.dump(idx, fh, ensure_ascii=False, separators=(',', ':'))

    for y in idx['years']:
        print(y['y'], ' | '.join('%s: %d گروه، %d ردیف' % (p['t'], p['g'], p['n']) for p in y['p']))
    if problems:
        print('\nموارد قابل توجه:')
        for p in problems:
            print(' -', p)


if __name__ == '__main__':
    main()
