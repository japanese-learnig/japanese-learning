# -*- coding: utf-8 -*-
"""
Unify all title suffixes to standard half-width format '(1)', '(2)', '(3)'...
Also fix Section 30, 31, 32 to clearly showてform:
- Sec 15: 基本動詞(1)
- Sec 19: 基本動詞(2)
- Sec 27: 基本動詞(3)
- Sec 30: 基本動詞(1) てform
- Sec 31: 基本動詞(2) てform
- Sec 32: 基本動詞(3) てform
- Sec 33: 基本動詞(4)
- Sec 34: 基本動詞(5)
- Sec 22: い形容詞(1)
- Sec 35: い形容詞(2)
- Sec 37-41: ないform (1) 〜 (5)
- Sec 42-43: 可能形 (1) 〜 (2)
"""

import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATA_JS_PATH = os.path.join(BASE_DIR, "public", "js", "data.js")
CATALOG_PATH = os.path.join(BASE_DIR, "public", "database", "sections_catalog.json")

TITLE_MAPPING = {
    15: "基本動詞(1)",
    19: "基本動詞(2)",
    22: "い形容詞(1)",
    27: "基本動詞(3)",
    30: "基本動詞(1) てform",
    31: "基本動詞(2) てform",
    32: "基本動詞(3) てform",
    33: "基本動詞(4)",
    34: "基本動詞(5)",
    35: "い形容詞(2)",
    37: "ないform (1)",
    38: "ないform (2)",
    39: "ないform (3)",
    40: "ないform (4)",
    41: "ないform (5)",
    42: "可能形 (1)",
    43: "可能形 (2)",
}

def run():
    with open(DATA_JS_PATH, "r", encoding="utf-8") as f:
        text = f.read()

    idx1 = text.find("window.INITIAL_VOCAB_DATA = ") + len("window.INITIAL_VOCAB_DATA = ")
    idx2 = text.find("];", idx1) + 1
    cards = json.loads(text[idx1:idx2].strip())

    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    # Update cards
    for c in cards:
        sn = c.get("section_num")
        if sn in TITLE_MAPPING:
            new_title = TITLE_MAPPING[sn]
            c["section_title"] = new_title
            c["category"] = new_title

    # Update catalog
    for entry in catalog:
        sn = entry.get("num")
        if sn in TITLE_MAPPING:
            entry["title"] = TITLE_MAPPING[sn]

    # Save catalog
    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
    print("Updated sections_catalog.json!")

    # Save data.js
    header = "// Haku-sensei's Japanese Flashcards Complete Master Data\n" \
             f"// {len(cards)} curated cards with 100% textbook accuracy\n" \
             "// Full <ruby> furigana on ALL kanji, authentic conversational dialogues, top 10 surnames, explicit verb conjugations.\n\n"
    
    vocab_str = "window.INITIAL_VOCAB_DATA = " + json.dumps(cards, ensure_ascii=False, indent=2) + ";\n\n"
    sections_str = "// Pre-compiled sections map for instant lookup\n" \
                   "window.SECTIONS_DATA = " + json.dumps(catalog, ensure_ascii=False, indent=2) + ";\n"

    with open(DATA_JS_PATH, "w", encoding="utf-8") as f:
        f.write(header + vocab_str + sections_str)
    print("Updated public/js/data.js!")

if __name__ == "__main__":
    run()
