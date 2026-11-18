# Massar Voice — score entry for Massar NotesCC exports

```
npm install
npm run dev      # http://localhost:5174 — open in Chrome or Edge
npm test         # unit + file-integrity tests (needs the .xlsx files in test/fixtures/)
```

## Use
1. Drop Massar `export_notesCC_*.xlsx` files on the page — one tab per class.
2. Pick the exam column (الفرض الأول / الثاني / الثالث / الأنشطة).
3. Enter scores by voice (🎤 استماع) or by typing, then **⬇ تصدير الملف**.
   The exported file is the original with only the edited score cells changed.

The session (files, scores, learned names) autosaves in the browser.

### Saying / typing an entry
| Example | Meaning |
|---|---|
| `بوزيدي عثمان خمسطاش ونص` | name + score (15.50) |
| `رقم 5 تلطاش لا ربع` · typed `#5 12.75` | student #5 in the list + score |
| `بوزيدي عثمان` … then `19` | name first, score next |
| `بوزيدي 15` (twins) | numbered choice → say `واحد` / `جوج` / `تلاتة` or press 1/2/3 |

Scores: Darija/MSA words or digits, `و ربع` +.25, `و نص` +.50, `لا ربع` −.25; must be 0–20 in steps of .25.
An empty cell is written immediately; replacing an existing score asks first.
If a spoken name isn't found, click the right student once — that heard text is remembered for the class.

### Voice commands (whole utterance only)
| Say | Action |
|---|---|
| واخا | confirm a replacement |
| لا | cancel replacement / choice |
| واحد / جوج / تلاتة | choose 1/2/3 (only while a choice is open) |
| رجع | undo last entry |
| شكون بقا | show students without a score |
| فرض الأول / فرض تاني / فرض تالت / الأنشطة | switch exam column |
| حبس | stop listening |
| سجل | export |
| عاود | restart listening — also works at the end of a stuck phrase («… عاود») |

### Noisy places (café, classroom)
- **✋ Push-to-talk:** tap ✋ once, then hold the mic button (or Space) while you speak.
  Only what you say while holding is heard. On phones the button is big at the bottom of the screen.
- No need to wait for a pause: a complete «name/رقم + score» that stays the same for ~1 s is used right away.
- Background chatter is ignored quietly: long sentences, low-confidence results, unknown words without a score.
- A doubtful name match asks «هل تقصد …؟» — say واخا or لا.
- «ونص» / «و ربع» / «لا ربع» said right after an entry corrects it if Chrome cut it off.
- Stuck on noise? Say «عاود» or tap ↻. The app also restarts by itself after 12 s without a result.
- The microphone is opened with noise suppression and echo cancellation where the browser allows it.

Speech recognition is done by the browser's online service (Google for Chrome, Microsoft for Edge).

## Notes
- Code: `src/xlsx/massar.ts` (surgical export), `src/score/darija.ts` (score parser),
  `src/match/` (name + number matching), `src/voice/` (recognizer, interpretation, commands).
- `test/fixtures/*.xlsx` contain real student data and are git-ignored.
