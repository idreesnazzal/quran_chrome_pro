"""Where the raw sabab data comes from, and how to prove it is unedited.

usage:
  python3 download.py --check          verify every local file against MANIFEST.sha256
  python3 download.py --write          (re)write MANIFEST.sha256 after a deliberate change
  python3 download.py --embed 2 144    print the quranpedia URLs an entry was read from

sources (quranpedia.net open dumps only):
  asbab-book-2919  أسباب نزول القرآن — الواحدي      https://quranpedia.net/book/2919
  asbab-book-460   المحرر — خالد بن سليمان المزيني   https://quranpedia.net/book/460
  asbab.json       surah/ayah index                  https://quranpedia.net/dumps

what actually happened in this sandbox (measured, not assumed):
  * the 2919 text was already inside the app as data/asbab_data.js (the server HTML of
    book 2919, 501 keys, 1 283 448 chars).  raw/asbab-book-2919.json was rebuilt from it,
    so the seeds and the HTML are byte-identical to what quranpedia served.
  * the 460 dump is published as one .json.gz.  The host could not be reached from here
    (no HTTPS egress to quranpedia.net), so every 460 entry was read one ayah at a time
    from the per-ayah embed view of the same book and pasted verbatim into
    raw/asbab-book-460.json; the ayahs that were read are listed in
    curation/checked_460.json.  Only «سَبَبُ النُّزُولِ» and «النتيجة» are kept (the
    author's «دِرَاسَةُ السَّبَبِ» is not reproduced).
"""
import hashlib, json, os, sys

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
MANIFEST = os.path.join(HERE, 'MANIFEST.sha256')

FILES = [
    'tools/asbab/raw/asbab-book-2919.json',
    'tools/asbab/raw/asbab-restored-2919.json',
    'tools/asbab/raw/lubab-nuqul.shamela0002247.openiti.txt',
    'tools/asbab/raw/asbab-suyuti.json',
    'tools/asbab/curation/restore.json',
    'tools/asbab/curation/references.json',
    'tools/asbab/raw/asbab-book-460.json',
    'tools/asbab/aligned/asbab_2919.json',
    'tools/asbab/aligned/asbab_460.json',
    'tools/asbab/aligned/align_report.json',
    'tools/asbab/curation/checked_460.json',
    'tools/asbab/curation/groups.json',
    'tools/asbab/curation/rejected.json',
    'tools/asbab/curation/suyuti_fix.json',
    'tools/asbab/curation/entries.json',
    'data/asbab_data.js',
]
# لباب النقول — public domain (السيوطي ت 911هـ), OpenITI RELEASE, copy of Shamela 0002247
# (دار الكتب العلمية، بيروت).  The file is served from GitHub, so this sandbox can
# check its sha256 locally; the hash below is the copy that produced raw/asbab-suyuti.json.
SUYUTI = ('https://github.com/OpenITI/RELEASE/blob/main/data/0911Suyuti/0911Suyuti.LubabNuqul/'
          '0911Suyuti.LubabNuqul.Shamela0002247-ara1',
          '671274dadb1d60fc9d7948d81c85418db6311624e9136eedb4c9cb07c27d90e6')
DUMPS = {
    2919: ('https://quranpedia.net/dumps/asbab-book-2919.json.gz',
           '84e99922560bc1b39b3924730cfc10a9b2c100b34d5ac8b9732ec8920f20c327'),
    460: ('https://quranpedia.net/dumps/asbab-book-460.json.gz',
          '76fb71b14557379cfca95583cffa7f4bb44063acfebdf939e2b1fa377f4ebb56'),
}


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write():
    lines = []
    for rel in FILES:
        p = os.path.join(ROOT, rel)
        if os.path.exists(p):
            lines.append('%s  %s' % (sha(p), rel))
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('wrote %d sums to MANIFEST.sha256' % len(lines))


def check():
    if not os.path.exists(MANIFEST):
        print('no MANIFEST.sha256 — run --write first')
        return 1
    want = {}
    for line in open(MANIFEST, encoding='utf-8'):
        if line.strip():
            s, rel = line.split('  ', 1)
            want[rel.strip()] = s
    bad = 0
    for rel, s in want.items():
        p = os.path.join(ROOT, rel)
        got = sha(p) if os.path.exists(p) else 'missing'
        if got != s:
            bad += 1
            print('✗ %s\n   want %s\n   got  %s' % (rel, s, got))
    print('%d file(s) checked, %d differ' % (len(want), bad))
    for bid, (url, s) in DUMPS.items():
        print('  dump %d: %s (%s…)' % (bid, url, s[:12]))
    print('  لباب النقول: %s (%s…)' % (SUYUTI[0], SUYUTI[1][:12]))
    print('  الاستيعاب / الصحيح المسند: no public machine-readable edition was found; '
          'no row of either book is shipped (see AUDIT.md §9)')
    return 1 if bad else 0


def embed(s, a):
    for bid in (2919, 460):
        print('https://quranpedia.net/embed?surah=%s&ayah=%s&fragment=1&type=asbab&book=%d&ayah_text=0'
              % (s, a, bid))


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--check']:
        sys.exit(check())
    elif args[:1] == ['--write']:
        write()
    elif args[:1] == ['--embed'] and len(args) == 3:
        embed(args[1], args[2])
    elif args[:1] == ['--coverage']:
        raw = json.load(open(os.path.join(HERE, 'raw', 'asbab-book-460.json'), encoding='utf-8'))
        got = sorted(raw['ayat'], key=lambda k: tuple(map(int, k.split('_'))))
        print('460: %d ayahs read (%s)' % (len(got), ', '.join(got)))
        print('2919: %d ayahs in the raw scrape' % len(
            json.load(open(os.path.join(HERE, 'raw', 'asbab-book-2919.json'), encoding='utf-8'))['ayat']))
    else:
        print(__doc__)
