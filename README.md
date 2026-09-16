# FJU Course Recommender Lite+

原專案 [`hyslchs/Course_Recommender_System`](https://github.com/hyslchs/Course_Recommender_System) 的精簡衍生版。Lite+ 保留「選課真的會用到」的功能，但不帶回大型模型、React 建置鏈與完整資料 pipeline。

## 目前功能

- 直接讀取輔仁大學公開課程大綱 API。
- 搜尋課名、教師、課號、系所。
- 依教師、系所／年級、班別、星期、節次、必選修、學分範圍篩選。
- 課名／教師／學分排序與完整分頁。
- 顯示課號、教師、學分、系所、班別、節次、教室與官方課程大綱。
- 多個課表方案：新增、改名、切換、刪除。
- 自動衝堂檢查與疑似同課號提醒。
- 視覺化週課表（D1～E4）。
- 規則式推薦：避開早八、避開星期五、偏好指定教師、偏好減少空堂。
- `localStorage` 保存方案與偏好，不需帳號或資料庫。
- 匯出 CSV、ICS；也可直接複製課表文字。
- 從舊 Lite 版自動匯入原本的暫存課表。

## 刻意不加入

- EmbeddingGemma / sentence-transformers。
- 向量檢索、BM25、RRF、MMR。
- 生成式 AI 助理與 OpenAI API。
- 複合查詢分析與大型推薦模型。
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

預設使用 115 學年度第 1 學期：

```bash
FJU_HY=115
FJU_HT=1
FJU_LCID=1028
FJU_SCO_TYP=100
FJU_CACHE_SECONDS=600
FJU_FETCH_CONCURRENCY=4
FJU_SEMESTER_START=2026-09-14
FJU_SEMESTER_WEEKS=18
```

`FJU_SEMESTER_START` 用於產生 ICS 的第一週日期。更換學期時請一起修改。

## 規則推薦怎麼算

推薦分數只用來協助排序，不代表課程品質，也不使用 AI：

- 與目前方案衝堂：大幅扣分。
- 開啟「避開 D1 早八」：D1 課程扣分。
- 開啟「避開星期五」：星期五課程扣分。
- 填入偏好教師且符合：加分。
- 開啟「課表集中」：能接續現有課程或集中在已有上課日會加分。

目前推薦排序是在「當前搜尋結果頁」內排序，避免一次把全校數千門課全部傳到瀏覽器。

## ICS 說明

Lite+ 內建輔大 D1～E4 節次時間，並依 `FJU_SEMESTER_START` 建立每週重複事件。ICS 不會自動排除國定假日、停課日或個別課程異動，匯入行事曆後仍應以學校公告為準。

## 架構

```text
瀏覽器（原生 HTML / CSS / JS）
       │
       ├─ localStorage：多方案、偏好
       │
       ▼
FastAPI app.py
       │
       ▼
輔仁大學公開課程大綱 API
```

## 授權與來源

本專案為原專案的簡化衍生版，保留 Apache License 2.0。原專案與本專案皆非輔仁大學官方服務。課程資料來自輔仁大學公開課程大綱 API。
