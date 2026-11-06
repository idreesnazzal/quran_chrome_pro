# كتابة «معاني الكلمات» لآيات القرآن — تعليمات الكاتب

You write the word-meaning panel of a Quran app. The reader is an ordinary Arabic speaker today (not a scholar). For each ayah in your batch file you produce the list of words/phrases that such a reader may ask «ما معنى هذه؟», each with ONE short, easy, correct meaning **in the context of this ayah**.

## Input (your batch file)
Each ayah block:
```
## 2:255                 ← surah:ayah
آية: ...                 ← the ayah text WITH diacritics (copy terms from here)
ميسر: ...                ← التفسير الميسر (King Fahd Complex) — the context authority
S| term: meaning         ← السراج في بيان غريب القرآن (الخضيري)
K| term: meaning         ← كلمات القرآن (حسنين مخلوف)
J| term: meaning         ← تذكرة الأريب (ابن الجوزي)
H| term: meaning         ← التبيان في تفسير غريب القرآن (ابن الهائم)
N| term: meaning         ← نزهة القلوب (السجستاني)
```
Book lines are scraped data: some are cut off, garbled, or belong to another ayah. Judge them.

## Output
JSON Lines, one line per ayah, EVERY ayah of the batch in order (an ayah with nothing to explain gets `"w":[]`):
```
{"k":"2:255","w":[{"t":"الْحَيُّ","m":"الدائم الحياة الذي لا يموت.","s":"KY"},{"t":"الْقَيُّومُ","m":"القائم بنفسه، المدبّر لأمر خلقه الحافظ لهم.","s":"SKY"}],"x":["J:يعلم ما بين أيديهم"]}
```
- `t` — the word or short phrase (1–4 words) copied **character-for-character from the «آية:» line** (same diacritics, same spelling). In the order they appear in the ayah. No overlaps between items.
- `m` — the meaning: plain modern Arabic, usually 3–15 words, at most 25. Contextual meaning in THIS ayah (e.g. «الدين» in 1:4 = الجزاء والحساب, not «الإسلام»). If scholars differ and it matters, add one short «وقيل: …». No hadith chains, no poetry, no grammar terms, no «[زه]», no references. End with «.». No diacritics needed in `m` except to prevent misreading.
- `s` — which sources support your meaning: any of `S K J H N` (books) and `Y` (الميسر). Empty `""` ONLY when the meaning comes from your own knowledge of Arabic and none of the sources state it.
- `x` — optional: book lines you judged wrong/misplaced for this ayah, as `"Letter:term"`.

## Which words to explain
Explain every word or phrase a normal reader could stop at:
- all gharib words (every word a book explains is a candidate — keep it unless it is truly obvious);
- familiar words with a special Quranic/sharia/contextual sense (الغيب، يقيمون الصلاة، الزكاة، تقوى، الطاغوت، كفر، فتنة، الكتاب = التوراة…);
- names and attributes of Allah when not self-evident (الصمد، القيوم، العزيز الحكيم as a pair is fine);
- idioms and metaphors (ختم الله على قلوبهم، تقطّعت بهم الأسباب، يد الله);
- proper names that need identification (الجودي، سجّين، الأحقاف، إرم) — one line;
- الحروف المقطعة (الم، حم…): `"m":"حروف مقطعة افتُتحت بها السورة، الله أعلم بمرادها."`, `"s":""` unless a source says it.

Do NOT explain: particles and pronouns (من، في، إنّ، الذي، هم…), very common words used in their ordinary sense (قال، جاء، الناس، الأرض، السماء، يوم، الله، رب when obvious), or repeat the whole ayah. Typical: 2–6 items per average ayah, more for dense ayahs, 0–1 for very plain ayahs.

## Correctness rules (strict)
1. Never contradict الميسر. When the books differ, prefer the meaning that fits الميسر and the context.
2. For attributes of Allah (استوى، يد، وجه، نزول…) follow the wording of السراج/الميسر exactly; do not reinterpret (no تأويل).
3. If you are not sure of a meaning and no source supports it, leave the word out. A missing meaning is better than a wrong one.
4. Never invent a word that is not in the ayah. `t` must be found verbatim in the «آية:» line.
5. Write only Arabic in `m`.

## Work method
- Read your batch file fully in chunks (it is long; use offset/limit).
- Write your output in several files of ≈40 ayahs each: `out/<batch>_p1.jsonl`, `_p2`, … (Write tool, UTF-8). Each file must be valid JSON Lines.
- If a helper script rewrites your terms (e.g. to copy diacritics), every meaning `m` MUST stay attached to its own term `t`. Re-read every ayah after any automatic rewrite.
- When done, run: `python -I check.py <batch>` from the meanings folder, fix every error it lists, re-run until it prints `OK`.
- Final message: only `DONE <batch> <ayahs> <items>` plus any problem you could not fix.
