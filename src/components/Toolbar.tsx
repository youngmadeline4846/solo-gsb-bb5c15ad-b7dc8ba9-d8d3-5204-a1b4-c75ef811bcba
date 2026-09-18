import type { Tool } from '../types';

interface Props {
  hasDoc: boolean;
  tool: Tool;
  zoom: number;
  pageNum: number;
  numPages: number;
  canUndo: boolean;
  canRedo: boolean;
  exporting: boolean;
  findOpen: boolean;
  onOpen(): void;
  onToolChange(tool: Tool): void;
  onToggleFind(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onRotate(): void;
  onPrevPage(): void;
  onNextPage(): void;
  onUndo(): void;
  onRedo(): void;
  onClearPage(): void;
  onExport(): void;
}

export function Toolbar(props: Props) {
  const {
    hasDoc,
    tool,
    zoom,
    pageNum,
    numPages,
    canUndo,
    canRedo,
    exporting,
    findOpen,
  } = props;

  return (
    <header className="toolbar">
      <div className="brand">PDF 安全遮盖台</div>

      <button onClick={props.onOpen}>导入 PDF</button>

      <div className="sep" />

      <button
        className={tool === 'draw' ? 'active' : ''}
        disabled={!hasDoc}
        onClick={() => props.onToolChange('draw')}
        title="拖拽绘制新的遮盖框"
      >
        绘制遮盖
      </button>
      <button
        className={tool === 'select' ? 'active' : ''}
        disabled={!hasDoc}
        onClick={() => props.onToolChange('select')}
        title="选择、移动、缩放已有遮盖框"
      >
        选择 / 调整
      </button>

      <div className="sep" />

      <button
        className={findOpen ? 'active' : ''}
        disabled={!hasDoc}
        onClick={props.onToggleFind}
        title="按词组在全文中查找并批量生成遮盖框（纯本地）"
      >
        文本查找遮盖
      </button>

      <div className="sep" />

      <button disabled={!hasDoc || !canUndo} onClick={props.onUndo} title="Ctrl+Z">
        撤销
      </button>
      <button disabled={!hasDoc || !canRedo} onClick={props.onRedo} title="Ctrl+Shift+Z / Ctrl+Y">
        重做
      </button>

      <div className="sep" />

      <button disabled={!hasDoc} onClick={props.onZoomOut} title="缩小">
        −
      </button>
      <span className="zoom-label">{Math.round(zoom * 100)}%</span>
      <button disabled={!hasDoc} onClick={props.onZoomIn} title="放大">
        +
      </button>
      <button disabled={!hasDoc} onClick={props.onRotate} title="顺时针旋转视图 90°（不影响导出）">
        旋转视图
      </button>

      <div className="sep" />

      <button disabled={!hasDoc || pageNum <= 1} onClick={props.onPrevPage}>
        上一页
      </button>
      <span className="page-label">
        {hasDoc ? `${pageNum} / ${numPages}` : '— / —'}
      </span>
      <button disabled={!hasDoc || pageNum >= numPages} onClick={props.onNextPage}>
        下一页
      </button>

      <div className="spacer" />

      <button disabled={!hasDoc} onClick={props.onClearPage} title="删除当前页全部遮盖框">
        清空本页
      </button>
      <button className="primary" disabled={!hasDoc || exporting} onClick={props.onExport}>
        {exporting ? '导出中…' : '导出安全 PDF'}
      </button>
    </header>
  );
}
