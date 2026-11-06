import json,glob,sys,re,collections
sys.path.insert(0,'.')
exec(open('merge.py',encoding='utf-8').read().split("rows = {}")[0].replace("APP = sys.argv[1]; ALLOW = \"--allow-missing\" in sys.argv",""))
idx=json.load(open('batches/index.json',encoding='utf-8'))
KEYS=sorted(C,key=lambda k:tuple(map(int,k.split(':'))))
for x in idx:
  i=KEYS.index(x['first']); ks=KEYS[i:i+x['n']]
  rows={}
  for f in glob.glob(f"out/{x['b']}_p*.jsonl"):
    for l in open(f,encoding='utf-8'):
      if l.strip(): r=json.loads(l); rows[r['k']]=r
  if len(rows)<len(ks): print(x['b'],'incomplete'); continue
  ai=sum(len(rows[k]['w']) for k in ks); miss=0; tot=0
  for k in ks:
    terms=set()
    for b,t,m in B.get(k,[]): terms.add(frozenset(toks(t)))
    cov=set().union(*[toks(w['t']) for w in rows[k]['w']]) if rows[k]['w'] else set()
    for t in terms:
      if not t: continue
      tot+=1
      if not (t & cov): miss+=1
  print(x['b'],x['first'],'ai/ayah %.2f'%(ai/len(ks)),'book-terms missed %d/%d = %.0f%%'%(miss,tot,100*miss/max(tot,1)))
