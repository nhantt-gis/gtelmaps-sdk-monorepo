// Phép hình học dùng chung của tầng dữ liệu giả: đo, chia nhỏ, và dời sang một bên.
//
// Ở vĩ độ này một độ kinh tuyến ăn 109 km và một độ vĩ tuyến 111 km. Cả khu chỉ
// rộng 10 km nên phép xấp xỉ phẳng ấy sai dưới một mét — đủ cho mọi thứ ở đây,
// và tránh phải kéo về một phép chiếu.

export const LON_M = 109000;
export const LAT_M = 111000;

export const metres = (a, b) => Math.hypot((a[0] - b[0]) * LON_M, (a[1] - b[1]) * LAT_M);

export const lengthOf = (path) => {
    let sum = 0;
    for (let i = 1; i < path.length; i++) sum += metres(path[i - 1], path[i]);
    return sum;
};

/** Thêm đỉnh vào những đoạn dài hơn `step`, giữ nguyên hình dạng. */
export function densify(path, step) {
    const out = [path[0]];
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const steps = Math.floor(metres(a, b) / step);
        for (let k = 1; k < steps; k++) {
            const t = k / steps;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
        out.push(b);
    }
    return out;
}

/** Chặn miter ở góc gấp: không có nó thì một khúc cua 150° bắn đỉnh đi hàng chục mét. */
const MIN_MITER_COS = 0.35;

/**
 * Hướng dời của từng đỉnh: **phân giác** của hai đoạn kề, không phải pháp tuyến
 * của một đoạn. Dời theo pháp tuyến thì ở mỗi khúc cua hai đoạn lệch ra hai chỗ
 * khác nhau và đường đứt quãng.
 */
export function bisectors(path) {
    const normals = [];
    for (let i = 1; i < path.length; i++) {
        const dx = (path[i][0] - path[i - 1][0]) * LON_M;
        const dy = (path[i][1] - path[i - 1][1]) * LAT_M;
        const len = Math.hypot(dx, dy) || 1;
        normals.push([-dy / len, dx / len]);
    }

    return path.map((point, i) => {
        const a = normals[i - 1] ?? normals[i];
        const b = normals[i] ?? normals[i - 1];
        let bx = a[0] + b[0];
        let by = a[1] + b[1];
        const len = Math.hypot(bx, by) || 1;
        bx /= len; by /= len;
        return {point, bx, by, scale: 1 / Math.max(MIN_MITER_COS, bx * b[0] + by * b[1])};
    });
}

/** Một đỉnh đã dời. `side` là +1 (trái theo chiều đi) hoặc −1 (phải). */
export const shift = (v, side, distance) => [
    v.point[0] + side * v.bx * distance * v.scale / LON_M,
    v.point[1] + side * v.by * distance * v.scale / LAT_M,
];

/** Đường song song với `path`, lệch `distance` mét về một bên. */
export const offsetPath = (path, side, distance) =>
    bisectors(path).map((v) => shift(v, side, distance));

/**
 * Làm tròn toạ độ về 6 chữ số trước khi ghi ra JSON.
 *
 * Sáu chữ số là **11 cm** ở vĩ độ này — dưới bề rộng một vệt sơn, và dưới xa
 * mọi thứ trang này vẽ. Không làm tròn thì `JSON.stringify` ghi đủ 15 chữ số của
 * một số thực đã qua vài phép nhân, tức 17 ký tự cho mỗi con số để mô tả một
 * khoảng cách nhỏ hơn nguyên tử.
 */
export const round6 = (path) => path.map(([x, y]) => [
    Math.round(x * 1e6) / 1e6,
    Math.round(y * 1e6) / 1e6,
]);
