# O'zbek / Русский — Telegram kanallar va guruhlar

## O'zbekcha (asosiy)

**Antigravity kvotasini OpenAI/Claude API ga aylantirdim — o'lchov bilan**

Antigravity har so'rovda o'zining 21,830 tokenlik "skafold"ini yuboradi: 65,891
belgilik system prompt, 14 ta tool deklaratsiyasi, har tool call uchun alohida
"rater" so'rovi va 235 MB `agy.exe` jarayoni. Bularning **hammasi klientda**
quriladi — to'g'ridan-to'g'ri `streamGenerateContent` chaqiruvi ularsiz ham
ishlaydi.

Natija: bir xil javob **6–38 prompt token** (21,830 o'rniga).

Nima qildim:
- OpenAI `chat/completions` + Claude `/v1/messages` — bitta portda
- thinking endi **raqam**: 1024/8192/30000 → 153/348/1218 thought token (o'lchangan)
- Windows ilova: API tab (kalit yaratish/rotate/revoke) + chat tab (jonli reasoning)
- CLI: `--doctor`, `--where`, `--selftest` (14/14)
- npm paketsiz, build'isiz, 8 MB sirli binary'siz

**Ochiq aytaman:** Gemini'ning server tomonidagi content filter'i va model
rad javoblari **o'zgarmagan** — ular oddiy 200 bo'lib qaytadi. Bu "filtrni
chetlab o'tish" emas, README'da qalin harflar bilan yozilgan.

https://github.com/crackallergicaleinstein/crackagravity

## Русский

**Квота Antigravity как OpenAI/Claude-совместимый endpoint — с замерами**

CLI Antigravity добавляет к каждому запросу ~21 830 prompt-токенов своего
скаффолдинга: системный промпт на 65 891 символ, 14 объявлений инструментов,
отдельный запрос «ratifier» на каждый tool call и процесс на 235 МБ. Всё это
строится **на клиенте**; прямой вызов `streamGenerateContent` в этом не нуждается.

Тот же ответ: **6–38 prompt-токенов**.

- OpenAI `chat/completions` + Claude `/v1/messages` на одном порту
- thinking — числом: 1024/8192/30000 → 153/348/1218 thought-токенов (замерено)
- Windows-приложение: вкладка API (ключи, ротация, отзыв) и вкладка чата с живым reasoning
- CLI с `--doctor`, `--where`, `--selftest` (14/14)
- без npm-зависимостей и сборки

**Честно:** серверный контент-фильтр Gemini и отказы модели **не тронуты** —
они приходят обычным 200. Это не обход фильтра, и README говорит это прямым
текстом.

https://github.com/crackallergicaleinstein/crackagravity
