/**
 * Giữ nguyên **danh tính** của object layout trong khi vẫn bật tắt được layer.
 *
 * `updateLayer` của `<Layer>` so `props.layout !== prevProps.layout` trước, rồi
 * mới duyệt từng khoá bằng `deepEqual`. Một object viết thẳng trong JSX là một
 * danh tính mới ở **mỗi** lần render, nên cả bộ property bị quét lại mỗi khi có
 * bất kỳ trạng thái nào khác đổi — kể cả những trạng thái không liên quan gì tới
 * layer ấy. Với `building-atlas-bay-width` thì cái quét ấy không rẻ: nó là layout
 * property, và chạm vào nó là parse lại mọi tile đang hiện.
 *
 * Trả về một trong hai bản đã đóng băng, đệm theo chính object layout gốc, nên
 * phép so ở trên rút về một lần `===`.
 */

type Visibility = {visibility: 'visible' | 'none'};
type Variants = {readonly visible: object; readonly hidden: object};

const cache = new WeakMap<object, Variants>();

export function withVisibility<T extends object>(layout: T, visible: boolean): T & Visibility {
  let variants = cache.get(layout);
  if (!variants) {
    variants = Object.freeze({
      visible: Object.freeze({...layout, visibility: 'visible'}),
      hidden: Object.freeze({...layout, visibility: 'none'}),
    });
    cache.set(layout, variants);
  }
  return (visible ? variants.visible : variants.hidden) as T & Visibility;
}

/**
 * Layout rỗng dùng chung cho layer không có layout property nào.
 *
 * Dùng chung được vì đệm ở trên khoá theo object gốc: mọi layer chỉ cần
 * `visibility` sẽ nhận đúng hai object ấy, và `<Layer>` vẫn so với `prevProps`
 * của riêng nó nên không có chỗ nào lẫn.
 */
export const NO_LAYOUT = Object.freeze({});
