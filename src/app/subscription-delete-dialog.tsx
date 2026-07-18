/**
 * 永久删除确认框只负责第二次明确授权，不持有订阅 ID、价格、Cookie 或错误详情。
 * 取消按钮自动聚焦并在 DOM 顺序上优先；删除请求进行时禁用两个按钮，避免管理员双击造成重复硬删除。
 */
export function SubscriptionDeleteDialog({
  subscriptionCount,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  subscriptionCount: number;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="subscription-delete-dialog-backdrop">
      <section className="subscription-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="subscription-delete-dialog-title">
        <p className="eyebrow">不可恢复操作</p>
        <h2 id="subscription-delete-dialog-title">永久删除订阅</h2>
        <p>将永久删除 {subscriptionCount} 个订阅及其地区映射、价格历史、采集日志和通知记录。此操作无法撤销。</p>
        <div className="subscription-delete-dialog__actions">
          <button className="secondary-button" type="button" autoFocus disabled={isDeleting} onClick={onCancel}>取消</button>
          <button className="danger-button" type="button" disabled={isDeleting} onClick={onConfirm}>{isDeleting ? "删除中…" : "永久删除"}</button>
        </div>
      </section>
    </div>
  );
}
