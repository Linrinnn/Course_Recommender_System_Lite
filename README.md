# FJU Course Recommender Lite+

原專案 [`hyslchs/Course_Recommender_System`](https://github.com/hyslchs/Course_Recommender_System) 的精簡衍生版。目標是盡量保留原專案真正好用的「探索課程＋課表選課」流程，同時移除大型模型與複雜前端建置鏈。

## 目前功能

- 直接讀取輔仁大學公開課程大綱 API。
- 關鍵字搜尋：課名、英文課名、課號、教師、系所與可取得的課程標籤。
- 原專案風格的篩選：系所、星期、精確節次、學分、必／選修、部別、年級、教師、班別、日／夜間、時間資料與排序。
- 篩選 facet 由實際資料產生；資料源沒有提供的選項不會假裝有資料可篩。
- 完整分頁與 URL 條件保存，可直接分享特定搜尋條件。
- 課程卡顯示課號、教師、學分、系所、班別、節次、教室與官方課綱。
- 獨立課表視窗 `/schedule`。
- 多個課表方案：新增、改名、切換、刪除與清空。
- 視覺化 D0～E4 週課表與基本衝堂判斷。
- 點課表任何格子，直接搜尋「該星期＋該節次」的所有課程。
- 節次搜尋可再用課名／教師／課號／系所縮小結果，並直接加入目前課表。
- 可把節次條件帶回主搜尋頁繼續使用完整篩選。
- `localStorage` 保存課表方案，不需要帳號或資料庫。

## 與原專案仍有差異

原專案不是只使用輔大課程列表 API；它還有資料正規化／artifact pipeline，因此能提供更完整的課程分類、授課語言、教材語言、教學方式、評量方式、線上教學、修課資格等進階欄位。

Lite+ 目前直接使用公開課程 API，所以只顯示「目前資料源真的有提供」的篩選。若要進一步還原上述進階搜尋，下一階段要把原專案的正規化與課程詳細資料流程移植回來，而不是只新增沒有資料支撐的下拉選單。

## 刻意不加入

- EmbeddingGemma / sentence-transformers。
- 向量檢索、BM25、RRF、MMR。
- 生成式 AI 助理與 OpenAI API。
- React / TypeScript / HeroUI / Tailwind 建置鏈。
- 原專案完整分析、評估與部署系統。

## 啟動

需求：Python 3.11+

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app:app --reload
```

開啟：

- 搜尋：`http://127.0.0.1:8000/`
- 獨立課表：`http://127.0.0.1:8000/schedule`

## 學期設定

```bash
FJU_HY=115
FJU_HT=1
FJU_LCID=1028
FJU_SCO_TYP=100
FJU_CACHE_SECONDS=600
FJU_FETCH_CONCURRENCY=4
```

## 架構

```text
主搜尋頁 ─────────────┐
                      ├─ localStorage：課表方案
獨立課表／節次搜尋 ───┘
        │
        ▼
FastAPI app.py
        │
        ▼
輔仁大學公開課程大綱 API
```

## 授權與來源

本專案為原專案的簡化衍生版，保留 Apache License 2.0。原專案與本專案皆非輔仁大學官方服務。課程資料來自輔仁大學公開課程大綱 API。
