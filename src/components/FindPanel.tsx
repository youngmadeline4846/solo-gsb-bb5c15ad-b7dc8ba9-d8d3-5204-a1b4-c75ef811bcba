import { useMemo } from 'react';
import type { FindHit } from '../types';

export type FindStatus =
  | { kind: 'idle' }
  | { kind: 'scanning'; done: number; total: number }
  | { kind: 'done' }
  | { kind: 'cancelled'; partial: boolean }
  | { kind: 'empty-query' }
  | { kind: 'error'; message: string };

interface Props {
  queryInput: string;
  onQueryInputChange(v: string): void;
  onSearch(): void;
  onCancel(): void;
  scanning: boolean;
  status: FindStatus;
  /** 页号 -> 命中（未被已有遮盖跳过的候选） */
  hitsByPage: Map<number, FindHit[]>;
  checked: Set<string>;
  onToggle(id: string): void;
  onTogglePage(page: number, on: boolean): void;
  onToggleAll(on: boolean): void;
  onApply(): void;
  onClose(): void;
  onJump(page: number): void;
  currentPage: number;
  /** 搜索时解析出的有效词数量 */
  queryCount: number;
  /** 第一个查询词的预览，用于无结果提示 */
  firstQuery: string;
  noTextPages: number[];
  skippedCount: number;
  appliedCount: number;
}

export function FindPanel(props: Props) {
  const pages = useMemo(
    () => [...props.hitsByPage.keys()].sort((a, b) => a - b),
    [props.hitsByPage],
  );
  const allHits = useMemo(
    () => pages.flatMap((p) => props.hitsByPage.get(p)!),
    [pages, props.hitsByPage],
  );
  const totalHits = allHits.length;
  const checkedCount = allHits.filter((h) => props.checked.has(h.id)).length;
  const allChecked = totalHits > 0 && checkedCount === totalHits;

  return (
    <aside className="find-panel">
      <div className="find-head">
        <span className="find-title">文本查找遮盖</span>
        <button className="find-close" onClick={props.onClose} title="关闭面板" aria-label="关闭">
          ×
        </button>
      </div>

      <form
        className="find-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.scanning) props.onSearch();
        }}
      >
        <textarea
          className="find-input"
          value={props.queryInput}
          onChange={(e) => props.onQueryInputChange(e.target.value)}
          placeholder={'输入要遮盖的词或短语\n每行一个，连续空白按一个空格匹配'}
          rows={4}
          spellCheck={false}
          disabled={props.scanning}
        />
        <div className="find-actions">
          {props.scanning ? (
            <button type="button" className="danger" onClick={props.onCancel}>
              取消扫描
            </button>
          ) : (
            <button type="submit" className="primary">
              查找
            </button>
          )}
        </div>
        <div className="find-hint">每行一个词组；纯本地解析，文件不会上传。</div>
      </form>

      {props.status.kind === 'scanning' && (
        <div className="find-status progress">
          正在逐页提取文字：第 {props.status.done} / {props.status.total} 页
          <div className="find-progress-track">
            <div
              className="find-progress-bar"
              style={{ width: `${(props.status.done / Math.max(1, props.status.total)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {props.status.kind === 'empty-query' && (
        <div className="find-status warn">请输入至少一个非空白的查找词（每行一个）。</div>
      )}
      {props.status.kind === 'error' && (
        <div className="find-status warn">{props.status.message}</div>
      )}
      {props.status.kind === 'cancelled' && (
        <div className="find-status warn">
          扫描已取消{props.status.partial ? '，以下为取消前已扫描页面的结果' : '，没有保留任何结果。'}
        </div>
      )}

      {(props.status.kind === 'done' ||
        (props.status.kind === 'cancelled' && props.status.partial)) && (
        <div className="find-result-meta">
          {totalHits > 0 ? (
            <div className="find-status ok">
              共 {totalHits} 处候选{checkedCount !== totalHits ? `，已勾选 ${checkedCount} 处` : '（已全选）'}
              {props.skippedCount > 0 && `；另有 ${props.skippedCount} 处与已有遮盖坐标相同，已跳过`}
            </div>
          ) : (
            <div className="find-status warn">
              {`已扫描${props.status.kind === 'cancelled' ? '的页面中' : '全部页面'}，未找到与「${props.queryCount > 1 ? `${props.queryCount} 个词组` : props.firstQuery}」匹配的文字。`}
            </div>
          )}
          {props.noTextPages.length > 0 && (
            <div className="find-status dim">
              第 {formatPageList(props.noTextPages)} 页没有可提取的文字（可能是扫描件 / 图片页）。
            </div>
          )}
          {totalHits === 0 && props.noTextPages.length === 0 && (
            <div className="find-status dim">可尝试更换词组，或改用手工绘制遮盖。</div>
          )}
          {props.appliedCount > 0 && (
            <div className="find-status ok">已将 {props.appliedCount} 处候选加入遮盖（整批为一条撤销记录）。</div>
          )}
        </div>
      )}

      {totalHits > 0 && (
        <>
          <div className="find-selectbar">
            <label>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => props.onToggleAll(e.target.checked)}
              />{' '}
              全选
            </label>
            <span className="dim">{checkedCount} / {totalHits}</span>
            <button
              className="primary small"
              disabled={checkedCount === 0 || props.scanning}
              onClick={props.onApply}
              title="把勾选的候选一次加入遮盖，整批只产生一条撤销记录"
            >
              加入遮盖（{checkedCount}）
            </button>
          </div>

          <div className="find-results">
            {pages.map((p) => {
              const hits = props.hitsByPage.get(p)!;
              const pageChecked = hits.every((h) => props.checked.has(h.id));
              const someChecked = hits.some((h) => props.checked.has(h.id));
              return (
                <div key={p} className={`find-group${p === props.currentPage ? ' current' : ''}`}>
                  <div className="find-group-head">
                    <div className="find-group-title">
                      <label className="find-hit-check">
                        <input
                          type="checkbox"
                          checked={pageChecked}
                          ref={(el) => {
                            if (el) el.indeterminate = !pageChecked && someChecked;
                          }}
                          onChange={(e) => props.onTogglePage(p, e.target.checked)}
                        />
                      </label>
                      <button type="button" className="find-page-link" onClick={() => props.onJump(p)}>
                        第 {p} 页
                      </button>
                    </div>
                    <span className="dim">{hits.length} 处</span>
                  </div>
                  <ul className="find-hit-list">
                    {hits.map((h) => (
                      <li key={h.id} className={props.checked.has(h.id) ? 'checked' : ''}>
                        <label className="find-hit-check">
                          <input
                            type="checkbox"
                            checked={props.checked.has(h.id)}
                            onChange={() => props.onToggle(h.id)}
                          />
                        </label>
                        <code
                          className="find-snippet"
                          title="点击跳转到该页"
                          onClick={() => props.onJump(h.page)}
                        >
                          {h.snippet}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}

function formatPageList(pages: number[]): string {
  if (pages.length <= 8) return pages.join('、');
  return `${pages.slice(0, 8).join('、')} 等 ${pages.length} 页`;
}
