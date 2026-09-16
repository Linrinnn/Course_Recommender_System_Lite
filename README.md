# FJU Course Recommender Lite

原專案 [`hyslchs/Course_Recommender_System`](https://github.com/hyslchs/Course_Recommender_System) 的精簡衍生版。

## 保留功能

- 直接讀取輔仁大學公開課程大綱 API。
- 搜尋課名、教師、課號、系所。
- 依星期、必修／選修篩選。
- 顯示教師、學分、上課節次與教室。
- 一鍵開啟官方課程大綱。
- 將課程暫存在瀏覽器 `localStorage`。
- 加入課表時，以「同星期＋相同節次」檢查衝堂。

## 移除功能

- EmbeddingGemma / sentence-transformers。
- 向量檢索、BM25、RRF、MMR。
- 生成式 AI 助理與 OpenAI API。
- 複合查詢分析、使用者資格推薦、分析儀表板。
- IndexedDB 大型 artifact 快取、Docker、評估資料與完整爬蟲 pipeline。
- React / TypeScript / HeroUI / Tailwind 建置鏈。

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

開啟 `http://127.0.0.1:8000`。

## 學期設定

預設使用 115 學年度第 1 學期，可用環境變數修改：

```bash
FJU_HY=115
FJU_HT=1
FJU_LCID=1028
FJU_SCO_TYP=100
FJU_CACHE_SECONDS=600
```

## 架構

```text
瀏覽器（原生 HTML / CSS / JS）
       │
       ▼
FastAPI app.py
       │
       ▼
輔仁大學公開課程大綱 API
```

這個版本的目的不是重做原專案完整推薦演算法，而是保留日常最常用的「找課＋篩選＋暫存課表＋衝堂檢查」。

## 授權與來源

本專案為原專案的簡化衍生版，保留 Apache License 2.0。原專案與本專案皆非輔仁大學官方服務。課程資料來自輔仁大學公開課程大綱 API。
