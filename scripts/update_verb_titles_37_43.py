# -*- coding: utf-8 -*-
"""
Update sections 37 through 43 titles:
- 37: 基本動詞 ないform (1)
- 38: 基本動詞 ないform (2)
- 39: 基本動詞 ないform (3)
- 40: 基本動詞 ないform (4)
- 41: 基本動詞 ないform (5)
- 42: 基本動詞 可能形 (1)
- 43: 基本動詞 可能形 (2)
"""

import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATA_JS_PATH = os.path.join(BASE_DIR, "public", "js", "data.js")
CATALOG_PATH = os.path.join(BASE_DIR, "public", "database", "sections_catalog.json")

NEW_TITLES = {
    37: "基本動詞 ないform (1)",
    38: "基本動詞 ないform (2)",
    39: "基本動詞 ないform (3)",
    40: "基本動詞 ないform (4)",
    41: "基本動詞 ないform (5)",
    42: "基本動詞 可能形 (1)",
    43: "基本動詞 可能形 (2)"
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
        if sn in NEW_TITLES:
            t = NEW_TITLES[sn]
            c["section_title"] = t
            c["category"] = t

    # Update catalog
    for entry in catalog:
        sn = entry.get("num")
        if sn in NEW_TITLES:
            entry["title"] = NEW_TITLES[sn]

    # Save catalog
    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    # Save data.js
    header = "// Haku-sensei's Japanese Flashcards Complete Master Data\n" \
             f"// {len(cards)} curated cards with 100% textbook accuracy\n" \
             "// Full <ruby> furigana on ALL kanji, authentic conversational dialogues, top 10 surnames, explicit verb conjugations.\n\n"
    
    vocab_str = "window.INITIAL_VOCAB_DATA = " + json.dumps(cards, ensure_ascii=False, indent=2) + ";\n\n"
    sections_str = "// Pre-compiled sections map for instant lookup\n" \
                   "window.SECTIONS_DATA = " + json.dumps(catalog, ensure_ascii=False, indent=2) + ";\n"

    with open(DATA_JS_PATH, "w", encoding="utf-8") as f:
        f.write(header + vocab_str + sections_str)

    print("Successfully updated sections 37 to 43 titles to include '基本動詞'!")

if __name__ == "__main__":
    run()
