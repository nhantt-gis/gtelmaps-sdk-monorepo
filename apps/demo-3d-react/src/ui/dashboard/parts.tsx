/**
 * Những mảnh nhỏ của bảng điều khiển.
 *
 * Tên class lấy nguyên của `3d-plugins` (`cd-sim-*`) — xem đầu `styles.css`.
 * Không mảnh nào giữ state: tất cả đều nhận giá trị và trả lại thao tác, còn
 * trạng thái nằm ở `state.tsx`.
 */

import type {ReactNode} from 'react';

export function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <>
      <div className='cd-sim-sec'>
        <span className='cd-sim-sec-t'>{title}</span>
      </div>
      {children}
    </>
  );
}

/** Dòng giải thích dưới một ô — chỗ nói vì sao ô ấy tồn tại. */
export function Note({children}: {children: ReactNode}) {
  return <p className='cd-sim-note'>{children}</p>;
}

export function ToggleGrid({children}: {children: ReactNode}) {
  return <div className='cd-sim-toggles'>{children}</div>;
}

export function Toggle({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <label className='cd-sim-toggle' title={title}>
      <input type='checkbox' checked={checked} onChange={e => onChange(e.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Cách hiện con số cạnh nhãn; mặc định là chính nó. */
  format?: (value: number) => string;
  onChange: (next: number) => void;
}) {
  return (
    <div className='cd-sim-explode'>
      <div className='cd-sim-explode-label'>
        <span>{label}</span>
        <span className='cd-sim-val'>{format ? format(value) : value}</span>
      </div>
      <input
        className='cd-sim-explode-range'
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}

export type SegmentOption<T extends string> = {value: T; label: string};

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className='cd-sim-seg'>
      {options.map(option => (
        <button
          key={option.value}
          type='button'
          className={option.value === value ? 'cd-sim-seg-btn on' : 'cd-sim-seg-btn'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
