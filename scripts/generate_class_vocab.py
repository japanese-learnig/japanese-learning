import re
import json
import os
import time
import urllib.request
import urllib.parse

def load_raw_entries():
    doc_path = '/Users/yamauchimiku/.gemini/antigravity/brain/ec6a95ed-9e7e-4387-9259-8ceb8b5a3c3f/.system_generated/steps/2039/content.md'
    with open(doc_path, 'r', encoding='utf-8') as f:
        raw_lines = f.readlines()

    skip = True
    items = []
    notes = {}
    prev_item = None

    for l in raw_lines:
        if l.startswith('---'):
            skip = False
            continue
        if skip:
            continue
        s = l.strip()
        if not s:
            continue
        if s == 'elderly person':
            if items:
                items[-1] += ' elderly person'
            continue
        if s.startswith('※'):
            if prev_item:
                notes[prev_item] = s
            continue
        items.append(s)
        prev_item = s

    print(f"Total entries loaded: {len(items)}, with {len(notes)} notes")
    return items, notes

def clean_kanji_ruby(jp_text):
    # Converts text with furigana like '音楽 (おんがく)' or '持(も)ち帰(かえ)り'
    # Return (display_word, plain_reading)
    clean_jp = jp_text.replace('⭕', '').strip()
    
    # Check if pattern is multiple kanji(kana) like 持(も)ち帰(かえ)り
    kanji_paren_pat = re.compile(r'([一-龯]+)\s*[\(（]([ぁ-んァ-ヶ・ー]+)[\)）]')
    matches = list(kanji_paren_pat.finditer(clean_jp))
    
    if matches:
        # If whole word is kanji+reading like 音楽 (おんがく)
        if len(matches) == 1 and matches[0].start() == 0 and matches[0].end() == len(clean_jp):
            word = matches[0].group(1).strip()
            reading = matches[0].group(2).strip()
            return word, reading
        
        # Word is text with parens stripped
        word = re.sub(r'[\(（][ぁ-んァ-ヶ・ー]+[\)）]', '', clean_jp).strip()
        
        # Reading is constructed by replacing each kanji(kana) with kana
        reading = clean_jp
        for m in reversed(matches):
            reading = reading[:m.start()] + m.group(2) + reading[m.end():]
        reading = re.sub(r'[\(（][^\)）]+[\)）]', '', reading).strip()
        return word, reading

    # Check general paren like お年寄り（おとしより） or 見た目 みため
    m_read = re.search(r'[\(（]([^\)）]+)[\)）]', clean_jp)
    if m_read:
        reading = m_read.group(1).strip()
        word = re.sub(r'[\(（][^\)）]+[\)）]', '', clean_jp).strip()
        return word, reading
    
    # Check space separated reading like '見た目 みため'
    parts = clean_jp.split()
    if len(parts) == 2 and re.search(r'^[ぁ-んァ-ヶ]+$', parts[1]):
        return parts[0], parts[1]

    return clean_jp, clean_jp

def parse_entry(item, idx, note_text=''):
    parts = item.split('        ')
    p0, p1 = parts[0].strip(), parts[1].strip()
    
    # Decide which is JP and which is Meaning
    if '❌' in p0:
        meaning_raw, jp_raw = p0, p1
    elif '／' in p0 or re.match(r'^[a-zA-Z\(\"\'\~]', p0):
        meaning_raw, jp_raw = p0, p1
    elif '／' in p1 or re.match(r'^[a-zA-Z\(\"\'\~]', p1):
        jp_raw, meaning_raw = p0, p1
    else:
        kana0 = len(re.findall(r'[\u3040-\u309F\u30A0-\u30FF]', p0))
        kana1 = len(re.findall(r'[\u3040-\u309F\u30A0-\u30FF]', p1))
        if kana0 >= kana1:
            jp_raw, meaning_raw = p0, p1
        else:
            meaning_raw, jp_raw = p0, p1

    word, reading = clean_kanji_ruby(jp_raw)

    # French check
    fr = ''
    m_fr = re.search(r'\(([^)]*(?:Je |j\'|de |du |des|le |la |les|en |un |une|ruines|araignée|héros|pigeon|plante)[^)]*)\)', meaning_raw, re.IGNORECASE)
    cleaned_meaning = meaning_raw
    if m_fr:
        fr = m_fr.group(1).strip()
        cleaned_meaning = meaning_raw.replace(m_fr.group(0), '').strip()

    tokens = [t.strip() for t in cleaned_meaning.split('／') if t.strip()]

    en = ''
    ko = ''
    zh_tw = ''
    zh_hk = ''
    zh_cn = ''

    for t in tokens:
        if re.search(r'[\uAC00-\uD7AF]', t):
            if not ko: ko = t
            else: ko += ' / ' + t
        elif re.search(r'[\u4E00-\u9FFF]', t):
            if not zh_tw:
                zh_tw = t
            elif not zh_hk:
                zh_hk = t
            else:
                zh_hk += ' / ' + t
        elif re.search(r'[a-zA-Z]', t):
            if not en: en = t
            else: en += ' / ' + t

    if not zh_hk and zh_tw:
        zh_hk = zh_tw
    if not zh_cn and zh_tw:
        zh_cn = zh_tw
    if not en and tokens:
        en = tokens[0]

    return {
        'id': f'class_word_{idx+1:04d}',
        'word': word,
        'reading': reading,
        'meaning_raw': meaning_raw,
        'en': en,
        'ko': ko,
        'zh_tw': zh_tw,
        'zh_hk': zh_hk,
        'zh_cn': zh_cn,
        'fr': fr,
        'related': note_text
    }

def translate_batch(texts, target_lang):
    if not texts:
        return []
    joined = ' \n \n '.join(texts)
    url = f'http://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={target_lang}&dt=t&q=' + urllib.parse.quote(joined)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            res = json.loads(r.read().decode('utf-8'))
            full_text = ''.join([p[0] for p in res[0] if p[0]])
            items = [t.strip() for t in full_text.split('\n \n')]
            # If length mismatch, return individual translations
            if len(items) == len(texts):
                return items
    except Exception as e:
        print(f"Batch trans error for {target_lang}: {e}")
    
    # Fallback to item by item
    results = []
    for t in texts:
        try:
            url_single = f'http://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={target_lang}&dt=t&q=' + urllib.parse.quote(t)
            req_s = urllib.request.Request(url_single, headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'})
            with urllib.request.urlopen(req_s, timeout=6) as r:
                res_s = json.loads(r.read().decode('utf-8'))
                results.append(''.join([p[0] for p in res_s[0] if p[0]]))
        except Exception:
            results.append(t)
        time.sleep(0.05)
    return results

def main():
    items, notes = load_raw_entries()
    parsed_cards = []
    for idx, item in enumerate(items):
        note = notes.get(item, '')
        card = parse_entry(item, idx, note)
        parsed_cards.append(card)

    print(f"Parsed {len(parsed_cards)} cards. Starting multilingual completion...")

    # Find cards missing languages
    # Group indices needing translation
    missing_ko_indices = [i for i, c in enumerate(parsed_cards) if not c['ko']]
    missing_zh_indices = [i for i, c in enumerate(parsed_cards) if not c['zh_tw']]
    missing_fr_indices = [i for i, c in enumerate(parsed_cards) if not c['fr']]

    print(f"Missing KO: {len(missing_ko_indices)}")
    print(f"Missing ZH: {len(missing_zh_indices)}")
    print(f"Missing FR: {len(missing_fr_indices)}")

    # Translate missing KO in batches of 20
    batch_size = 20
    print("Translating missing Korean...")
    for b in range(0, len(missing_ko_indices), batch_size):
        chunk_indices = missing_ko_indices[b:b+batch_size]
        query_texts = [parsed_cards[i]['en'] or parsed_cards[i]['word'] for i in chunk_indices]
        trans_res = translate_batch(query_texts, 'ko')
        for i, res in zip(chunk_indices, trans_res):
            parsed_cards[i]['ko'] = res
        print(f"KO: {min(b+batch_size, len(missing_ko_indices))}/{len(missing_ko_indices)}")
        time.sleep(0.1)

    # Translate missing Chinese in batches of 20
    print("Translating missing Chinese...")
    for b in range(0, len(missing_zh_indices), batch_size):
        chunk_indices = missing_zh_indices[b:b+batch_size]
        query_texts = [parsed_cards[i]['en'] or parsed_cards[i]['word'] for i in chunk_indices]
        trans_res_tw = translate_batch(query_texts, 'zh-TW')
        for i, res in zip(chunk_indices, trans_res_tw):
            parsed_cards[i]['zh_tw'] = res
            parsed_cards[i]['zh_hk'] = res
            parsed_cards[i]['zh_cn'] = res
        print(f"ZH: {min(b+batch_size, len(missing_zh_indices))}/{len(missing_zh_indices)}")
        time.sleep(0.1)

    # Translate missing French in batches of 20
    print("Translating missing French...")
    for b in range(0, len(missing_fr_indices), batch_size):
        chunk_indices = missing_fr_indices[b:b+batch_size]
        query_texts = [parsed_cards[i]['en'] or parsed_cards[i]['word'] for i in chunk_indices]
        trans_res_fr = translate_batch(query_texts, 'fr')
        for i, res in zip(chunk_indices, trans_res_fr):
            parsed_cards[i]['fr'] = res
        print(f"FR: {min(b+batch_size, len(missing_fr_indices))}/{len(missing_fr_indices)}")
        time.sleep(0.1)

    # Format into standard flashcard cards
    final_cards = []
    for c in parsed_cards:
        final_cards.append({
            'id': c['id'],
            'word': c['word'],
            'reading': c['reading'],
            'category': '授業で習った言葉',
            'meaning': {
                'en': c['en'] or c['meaning_raw'],
                'zh_TW': c['zh_tw'] or c['en'] or c['meaning_raw'],
                'zh_CN': c['zh_cn'] or c['zh_tw'] or c['en'] or c['meaning_raw'],
                'ko': c['ko'] or c['en'] or c['meaning_raw'],
                'zh_HK': c['zh_hk'] or c['zh_tw'] or c['en'] or c['meaning_raw'],
                'fr': c['fr'] or c['en'] or c['meaning_raw']
            },
            'example': {
                'ja': f"{c['word']}を使ってみましょう。",
                'en': f"Let's practice using \"{c['word']}\".",
                'zh_TW': f"讓我們來練習使用「{c['word']}」吧。",
                'zh_CN': f"让我们来练习使用「{c['word']}」吧。",
                'ko': f"\"{c['word']}\"을(를) 사용해 연습해 봅시다.",
                'zh_HK': f"等我哋練習下用「{c['word']}」啦。",
                'fr': f"Pratiquons l'utilisation de « {c['word']} »."
            },
            'related': c['related'] or '授業の重要語彙'
        })

    # Save to public/database/class_vocab_data.js
    out_path = '/Users/yamauchimiku/.gemini/antigravity/scratch/japanese-flashcards/public/database/class_vocab_data.js'
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('// Auto-generated Class Vocabulary Data from Teacher Docs\n')
        f.write('window.CLASS_VOCAB_DATA = ')
        json.dump(final_cards, f, ensure_ascii=False, indent=2)
        f.write(';\n')

    print(f"Successfully wrote {len(final_cards)} cards to {out_path}!")

if __name__ == '__main__':
    main()
