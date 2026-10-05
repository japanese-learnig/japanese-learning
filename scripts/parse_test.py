import re
import json

with open('/Users/yamauchimiku/.gemini/antigravity/brain/ec6a95ed-9e7e-4387-9259-8ceb8b5a3c3f/.system_generated/steps/2039/content.md', 'r', encoding='utf-8') as f:
    raw_lines = f.readlines()

skip = True
items = []
for idx, l in enumerate(raw_lines):
    if l.startswith('---'):
        skip = False
        continue
    if skip:
        continue
    s = l.strip()
    if not s:
        continue
    if s == 'elderly person':
        items[-1] += ' elderly person'
        continue
    if s.startswith('※'):
        continue
    items.append(s)

print(f"Total raw items: {len(items)}")

def parse_card(item, idx):
    parts = item.split('        ')
    p0, p1 = parts[0].strip(), parts[1].strip()
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
    
    clean_jp = jp_raw.replace('⭕', '').strip()
    
    # Extract reading from parentheses if present
    m_read = re.search(r'[\(（]([^\)）]+)[\)）]', clean_jp)
    reading = ''
    word = clean_jp
    if m_read:
        reading = m_read.group(1).strip()
        word = re.sub(r'[\(（][^\)）]+[\)）]', '', clean_jp).strip()
    else:
        reading = clean_jp
    
    # Check for French in parentheses: e.g. "(J'ai confiance en moi)"
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
        'id': f'class_doc_{idx+1:04d}',
        'word': word,
        'reading': reading,
        'meaning_raw': meaning_raw,
        'en': en,
        'ko': ko,
        'zh_tw': zh_tw,
        'zh_hk': zh_hk,
        'zh_cn': zh_cn,
        'fr': fr
    }

for idx in [0, 5, 8, 64, 142, 500, 522, 524, 762, 1590]:
    card = parse_card(items[idx], idx)
    print(f"--- Item {idx+1} ---")
    print(f"Word: {card['word']} | Reading: {card['reading']}")
    print(f"EN: {card['en']}")
    print(f"KO: {card['ko']}")
    print(f"ZH_TW: {card['zh_tw']}")
    print(f"ZH_HK: {card['zh_hk']}")
    print(f"ZH_CN: {card['zh_cn']}")
    print(f"FR: {card['fr']}")
