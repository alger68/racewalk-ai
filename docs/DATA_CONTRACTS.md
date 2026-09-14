# 節點間的資料契約

各節點以明確的 schema 交換資料，任一節點的實作可單獨替換而不波及下游。
型別定義見 `racewalk/types.py`。

## frames — 逐幀關鍵點（N4–N5 輸出）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `frame_idx` | int | 解碼後的影格序號，從 0 起算 |
| `t_ms` | float | `frame_idx / fps * 1000` |
| `track_id` | int | 追蹤指派的選手編號 |
| `kp_x`, `kp_y` | float[26] | 關鍵點座標，影像座標系（y 向下為正） |
| `kp_conf` | float[26] | 各關鍵點信心度，0–1 |

**必須使用含足部的 26 點格式。** COCO 17 點只有踝關節，沒有腳跟與腳尖，
無法做觸地判定。

## events — 步態事件（N6 輸出）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `track_id` | int | |
| `event` | `IC` \| `TO` | |
| `foot` | `L` \| `R` | |
| `t_ms` | float | **次幀精度**，由門檻交越線性內插取得 |
| `confidence` | float | |
| `method` | str | 產生此事件的方法，供回溯 |

`t_ms` 是浮點數而非影格編號：若只到影格精度，誤差下限就是一個影格
（240 fps 下 4.2 ms），對 40 ms 的門檻來說太粗。

## steps — 逐步伐指標（N7 輸出）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `contact_ms` | float | 觸地時間 |
| `flight_ms` | float | 騰空時間 |
| `uncertainty_ms` | float | **必填**，不可省略 |
| `min_knee_angle` | float \| null | 觸地到垂直支撐期間的最小膝角（度） |
| `cadence_spm` | float | 步頻 |
| `step_len_m` | float \| null | 需要 homography 標定才有值 |

任何毫秒數都必須帶著 `uncertainty_ms` 一起流動。一個沒有誤差範圍的
騰空時間無法判讀，也無法與門檻比較。

## findings — 疑似項目（N8 輸出，M5 才實作）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `rule` | `loss_of_contact` \| `bent_knee` | |
| `verdict` | `suspected` \| `within_tolerance` \| `inconclusive` \| `unreliable` | |
| `confidence` | float | |
| `evidence_clip` | str | 前後 0.5 秒的片段路徑 |
| `reviewed_by`, `review_result` | str \| null | N10 人工複核回填 |

**`verdict` 沒有 `violation` 這個值。** 系統不做判罰，判定權屬於裁判。
`racewalk/capability.py` 的 `flight_verdict()` 以測試確保這一點。
