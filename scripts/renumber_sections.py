# -*- coding: utf-8 -*-
"""
Renumber all sections cleanly according to the right-side list and user request:
- Section 0: ★ まずは授業で使う単語を覚えよう！ (46語)
- Section 1: simple phrase (23語)
- Section 2: 身の回りのもの (23語)
- Section 3: 代名詞/家族 (28語)
- Section 4: 場所 (29語)
- Section 5: 動物 (16語)
- Section 6: 職業/身分 (27語)
- Section 7: 国/地名 (23語)
- Section 8: 体の名前 (23語)
- Section 9: 位置 (10語)
- Section 10: 基本の数字 (14語)
- Section 11: 日付（月/日） (25語)
- Section 12: 時間/時間帯 (31語)
- Section 13: もの/人の数え方 (30語)
- Section 14: 時間/時制表現 (25語)
- Section 15: 基本動詞 (26語)
- Section 16: 乗り物 (11語)
- Section 17: 時間/頻度 (19語)
- Section 18: 食べ物 (30語)
- Section 19: 基本動詞（2） (25語)
- Section 20: する動詞（名詞） (29語)
- Section 21: あいづち/接続し (27語)
- Section 22: い形容詞 (20語)
- Section 23: な形容詞 (20語)
- Section 24: 色/味 (19語)
- Section 25: 予定/映画/スポーツ (23語)
- Section 26: 季節/天気 (23語)
- Section 27: 基本動詞３ (18語)
- Section 28: お出掛け (19語)
- Section 29: 電車 (20語)
- Section 30: 基本動詞　〜てform (26語)
- Section 31: 基本動詞(2)てform (25語)
- Section 32: 基本動詞(3) (18語)
- Section 33: 基本動詞4 (19語)
- Section 34: 基本動詞5 (22語)
- Section 35: い形容詞(2) (19語)
- Section 36: 病気/症状 (27語)
- Section 37: ないform (1) (26語)
- Section 38: ないform (2) (25語)
- Section 39: ないform (3) (18語)
- Section 40: ないform (4) (19語)
- Section 41: ないform (5) (22語)
- Section 42: 可能形 (1) (26語)
- Section 43: 可能形 (2) (24語)
"""

import json
import re
import os

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATA_JS_PATH = os.path.join(BASE_DIR, "public", "js", "data.js")
CATALOG_PATH = os.path.join(BASE_DIR, "public", "database", "sections_catalog.json")

def run():
    with open(DATA_JS_PATH, "r", encoding="utf-8") as f:
        text = f.read()

    idx1 = text.find("window.INITIAL_VOCAB_DATA = ") + len("window.INITIAL_VOCAB_DATA = ")
    idx2 = text.find("];", idx1) + 1
    cards = json.loads(text[idx1:idx2].strip())

    # Map each card to its ordered section
    # Order definitions: (old_section_num, keyword_in_old_title) -> new_info
    ordered_definitions = [
        {"new_num": 0, "title": "まずは授業で使う単語を覚えよう！", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 0},
        {"new_num": 1, "title": "simple phrase", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 1},
        {"new_num": 2, "title": "身の回りのもの", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 3},
        {"new_num": 3, "title": "代名詞/家族", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 4},
        {"new_num": 4, "title": "場所", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 5},
        {"new_num": 5, "title": "動物", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 6},
        {"new_num": 6, "title": "職業/身分", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 7},
        {"new_num": 7, "title": "国/地名", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 8},
        {"new_num": 8, "title": "体の名前", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 9},
        {"new_num": 9, "title": "位置", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 10 and "位置" in c.get("section_title", "")},
        {"new_num": 10, "title": "基本の数字", "folder_id": "folder_1", "folder_name": "初級 1-10", "match": lambda c: c.get("section_num") == 10 and ("数字" in c.get("section_title", "") or "数字" in c.get("category", ""))},
        {"new_num": 11, "title": "日付（月/日）", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 11},
        {"new_num": 12, "title": "時間/時間帯", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 12},
        {"new_num": 13, "title": "もの/人の数え方", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 13},
        {"new_num": 14, "title": "時間/時制表現", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 14},
        {"new_num": 15, "title": "基本動詞", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 15},
        {"new_num": 16, "title": "乗り物", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 16},
        {"new_num": 17, "title": "時間/頻度", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 17},
        {"new_num": 18, "title": "食べ物", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 18},
        {"new_num": 19, "title": "基本動詞（2）", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 19},
        {"new_num": 20, "title": "する動詞（名詞）", "folder_id": "folder_2", "folder_name": "初級 11-20", "match": lambda c: c.get("section_num") == 20},
        {"new_num": 21, "title": "あいづち/接続し", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 21},
        {"new_num": 22, "title": "い形容詞", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 22},
        {"new_num": 23, "title": "な形容詞", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 23},
        {"new_num": 24, "title": "色/味", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 24},
        {"new_num": 25, "title": "予定/映画/スポーツ", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 25},
        {"new_num": 26, "title": "季節/天気", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 26},
        {"new_num": 27, "title": "基本動詞３", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 27},
        {"new_num": 28, "title": "お出掛け", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 28},
        {"new_num": 29, "title": "電車", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 29},
        {"new_num": 30, "title": "基本動詞　〜てform", "folder_id": "folder_3", "folder_name": "初級 21-30", "match": lambda c: c.get("section_num") == 30},
        {"new_num": 31, "title": "基本動詞(2)てform", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 31},
        {"new_num": 32, "title": "基本動詞(3)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 32},
        {"new_num": 33, "title": "基本動詞4", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 33},
        {"new_num": 34, "title": "基本動詞5", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 35},
        {"new_num": 35, "title": "い形容詞(2)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 37},
        {"new_num": 36, "title": "病気/症状", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 38},
        {"new_num": 37, "title": "ないform (1)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 39},
        {"new_num": 38, "title": "ないform (2)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 40},
        {"new_num": 39, "title": "ないform (3)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 41},
        {"new_num": 40, "title": "ないform (4)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 42},
        {"new_num": 41, "title": "ないform (5)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 43},
        {"new_num": 42, "title": "可能形 (1)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 44},
        {"new_num": 43, "title": "可能形 (2)", "folder_id": "folder_4", "folder_name": "初級 31-43", "match": lambda c: c.get("section_num") == 45},
    ]

    new_cards_list = []
    catalog_list = []

    for defn in ordered_definitions:
        new_num = defn["new_num"]
        clean_title = defn["title"]
        folder_id = defn["folder_id"]
        folder_name = defn["folder_name"]
        matcher = defn["match"]

        matched = [c for c in cards if matcher(c)]
        for c in matched:
            c_copy = dict(c)
            c_copy["section_num"] = new_num
            c_copy["section_title"] = clean_title
            c_copy["folder_id"] = folder_id
            c_copy["folder_name"] = folder_name
            c_copy["category"] = clean_title
            new_cards_list.append(c_copy)

        catalog_list.append({
            "num": new_num,
            "title": clean_title,
            "folder_id": folder_id,
            "folder_name": folder_name,
            "count": len(matched)
        })

    print(f"Total processed cards: {len(new_cards_list)} (original was {len(cards)})")
    assert len(new_cards_list) == len(cards), f"Card count mismatch! {len(new_cards_list)} vs {len(cards)}"

    # Re-assign sequential card IDs: card_0001 to card_1018
    for idx, c in enumerate(new_cards_list, start=1):
        c["id"] = f"card_{idx:04d}"

    # Write catalog
    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog_list, f, ensure_ascii=False, indent=2)
    print(f"Saved {len(catalog_list)} catalog entries to sections_catalog.json")

    # Write data.js
    header = "// Haku-sensei's Japanese Flashcards Complete Master Data\n" \
             f"// {len(new_cards_list)} curated cards with 100% textbook accuracy\n" \
             "// Full <ruby> furigana on ALL kanji, authentic conversational dialogues, top 10 surnames, explicit verb conjugations.\n\n"
    
    vocab_str = "window.INITIAL_VOCAB_DATA = " + json.dumps(new_cards_list, ensure_ascii=False, indent=2) + ";\n\n"
    sections_str = "// Pre-compiled sections map for instant lookup\n" \
                   "window.SECTIONS_DATA = " + json.dumps(catalog_list, ensure_ascii=False, indent=2) + ";\n"

    with open(DATA_JS_PATH, "w", encoding="utf-8") as f:
        f.write(header + vocab_str + sections_str)
    print("Saved public/js/data.js successfully!")

if __name__ == "__main__":
    run()
