# FJU Course Recommender Lite+

[`hyslchs/Course_Recommender_System`](https://github.com/hyslchs/Course_Recommender_System) 的精簡衍生版。目標不是把原專案砍成只有幾個篩選器，而是保留日常選課真正需要的「完整課程搜尋 + 浮動課表 + 節次找課」，同時移除 Embedding/RAG、React 建置鏈、分析儀表板等較重的部分。

## 目前功能

### 課程搜尋

基本資料不需額外建索引即可使用：

- 課名、英文課名、課號、教師、系所搜尋
- 系所、年級、部別、修課層級、班別
- 星期、單一節次、精確多節次
- 學分、必／選修、課程標籤
- 日間／晚間、時間已知／未定
- 分頁與排序

完整索引建立後，補回原專案的進階課綱欄位：

- 授課語言
- 教材語言
- 教學方式，以及「主要方式／至少達 X%」判定
- 評量方式，以及「主要方式／至少達 X%」判定
- 評量類型：無考試、考試、書面、報告、實作、課堂參與
- 線上教學：純實體、含線上、同步、非同步、同步＋非同步
- 課程能力／核心能力／特殊議題／SDGs 等關聯欄位
- 先修課程關鍵字
- 課程目標、每週進度、教材文字會納入關鍵字搜尋

關鍵字搜尋採確定性欄位加權，不使用生成式 AI。課名、課號與教師權重較高，課程目標、每週進度、先修、教材與能力欄位也會參與搜尋。

### 浮動課表

- 主搜尋頁按「查看課表」後，以 Modal 浮層顯示課表，不會跳離搜尋頁。
- `/schedule` 仍保留作為備用的獨立課表頁。
- 多個課表方案：新增、改名、切換、刪除、清空。
- D0～E4 視覺化週課表。
- 點任何空白或已有課程的節次，可以直接搜尋「星期 + 節次」的所有課。
- 節次結果可再用課名、教師、課號或系所縮小。
- 可以直接加入目前方案，並檢查同星期＋重疊節次的衝堂。
- 課表保存在瀏覽器 `localStorage`，不需要帳號。

## GitHub Pages 網頁版

本專案支援 GitHub Pages，不需要自己的電腦持續開著。

運作方式：

```text
GitHub Actions
   │
   ├─ 讀取輔大公開課程 API
   ├─ 建立／續跑完整課綱索引
   ├─ 產生 dist/data/catalog.json
   └─ 部署到 GitHub Pages
          │
          ▼
瀏覽器直接搜尋、篩選、排課
```

Pages 版使用 `static/pages-api.js` 在瀏覽器端提供與 FastAPI 相容的查詢介面，因此主搜尋、進階篩選、浮動課表與節次找課可以沿用同一套前端。

第一次使用 GitHub Pages 時，到 repository 的：

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

之後 `.github/workflows/pages.yml` 會在 `main` 更新時部署，也可從 Actions 手動執行；另外每週會自動更新一次課程快照。完整索引資料透過 GitHub Actions cache 續跑，避免每次從零開始。

預設網址會是：

```text
https://linrinnn.github.io/Course_Recommender_System_Lite/
```

## 完整搜尋索引

原專案的授課語言、教材語言、教學／評量方式、線上教學等資料，不存在於課程列表 API。Lite+ 因此沿用原專案的公開 API 資料流程，對每門課額外讀取：

- `OutlineMaintain/CourseDetailsData`
- `OutlineMaintain/CourseRelations`
- `OutlineMaintain/CourseInfoAndBook`
- `OutlineMaintain/CourseCP`
- `OutlineMaintain/CourseMethods`

本機版完整索引會寫入：

```text
data_runtime/enriched_<學年度>_<學期>.jsonl
```

索引可續跑。程式中斷或關閉後再次建立，只處理尚未完成的課程。

本機可在網站頂端按「建立／續跑完整索引」，或執行：

```bash
python build_catalog.py
```

先測試少量課程：

```bash
python build_catalog.py --limit 20
```

調整同時處理數量：

```bash
python build_catalog.py --concurrency 4
```

建議不要把 concurrency 調得過高，以降低對學校公開 API 的負載。

## 本機啟動

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

```text
http://127.0.0.1:8000
```

## 設定

```bash
FJU_HY=115
FJU_HT=1
FJU_LCID=1028
FJU_SCO_TYP=100
FJU_CACHE_SECONDS=600
FJU_FETCH_CONCURRENCY=4
FJU_DETAIL_CONCURRENCY=4
FJU_DATA_DIR=data_runtime
FJU_SEMESTER_START=2026-09-14
FJU_SEMESTER_WEEKS=18
```

## 架構

```text
本機模式
瀏覽器 → FastAPI → 輔大公開 API / data_runtime

GitHub Pages 模式
GitHub Actions → 靜態 catalog.json → 瀏覽器端 pages-api.js → 搜尋／課表
```

## 與原專案的差異

刻意不帶回：

- EmbeddingGemma / sentence-transformers
- 向量搜尋、BM25、RRF、MMR
- 生成式 AI 助理 / OpenAI API
- React / TypeScript / HeroUI / Tailwind
- Analytics、完整 artifact bundle、Docker 部署鏈

保留並重新實作的是課程資料正規化、進階欄位搜尋、課表與衝堂流程。

## 驗證

```bash
python -m py_compile app.py catalog.py build_catalog.py build_pages.py
python -m unittest discover -s tests -v
node --check static/app.js
node --check static/schedule.js
node --check static/schedule-modal.js
node --check static/pages-api.js
```

離線測試不需要連輔大 API；實際課程資料與完整索引仍以當學期公開 API 為準。

## 授權與來源

本專案為原專案的簡化衍生版，保留 Apache License 2.0 與來源說明。原專案與本專案皆非輔仁大學官方服務。課程資料來自輔仁大學公開課程大綱 API。