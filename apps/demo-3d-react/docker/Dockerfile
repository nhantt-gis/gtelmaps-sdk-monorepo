# =============================================================================
# demo-3d-react — image production: build tĩnh bằng Vite, phục vụ qua nginx.
#
# QUAN TRỌNG — build context là GỐC KHO, không phải thư mục này, vì bản build cần
# cả `packages/` lẫn `pnpm-lock.yaml`. Luôn kèm `-f`:
#
#     docker build -f apps/demo-3d-react/docker/Dockerfile -t <image> .
#
# (docker-compose.yml cạnh đây đã đặt `context: ../../..` sẵn; `task docker:build`
# thì gọi qua compose nên không phải nhớ.)
#
# HAI ĐIỀU KHÔNG GIỐNG MỘT DOCKERFILE VITE THÔNG THƯỜNG, ĐỌC TRƯỚC KHI SỬA:
#
# 1. Image này dựng từ CÂY LÀM VIỆC, không phải từ một bản checkout. Cả app lẫn
#    `packages/gtelmaps-gl-js/dist` đều chưa nằm trong git (`git ls-files
#    apps/demo-3d-react` trả về 0 file), nên `git clone` rồi build sẽ ra một image
#    rỗng. Các `COPY` ở stage builder liệt kê TƯỜNG MINH từng artefact dựng sẵn
#    thay vì `COPY . .`, để chính file này nói ra điều đó.
#
# 2. `public/` (31 MB tile/model/texture/sprite/api) KHÔNG nằm trong image. Nó
#    được mount `:ro` lúc chạy vào /srv/public — xem docker-compose.yml và
#    nginx.conf. Lý do: cây ấy sinh ra từ `sdk/3d-plugins/public/data`, một kho
#    ~150 MB ngoài monorepo và không có git remote, cần tippecanoe 1.36.0 +
#    sqlite3; và riêng `models/camera_cone*.glb` thì không script nào sinh lại
#    được. Dựng lại trong container là không làm được, không phải chậm.
# =============================================================================

# KHÔNG có dòng `# syntax=docker/dockerfile:1.7` ở đầu file: chỉ thị ấy kéo về một
# frontend riêng qua mạng rồi chạy nó như một tiến trình phụ, và trên máy đang tải
# nặng nó bị giết giữa chừng — `frontend grpc server closed unexpectedly`. BuildKit
# dựng sẵn trong Docker 27 đã hiểu `RUN --mount=type=cache` nên không cần nó.

# ---- Stage 1: builder ------------------------------------------------------
# node:20-alpine khớp Node 20.19.5 của máy phát triển (`engines` chỉ đòi >=18).
# Alpine dùng musl, và điều đó an toàn vì lockfile đã ghi sẵn
# `@rollup/rollup-linux-x64-musl` bên cạnh bản -gnu; esbuild là nhị phân Go tĩnh
# nên chạy trên cả hai.
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

# Manifest trước, nguồn sau: đổi mã nguồn thì layer cài đặt vẫn được dùng lại.
#
# `--frozen-lockfile` đối chiếu TOÀN BỘ danh sách importer trong pnpm-lock.yaml
# với workspace, nên phải copy đủ cả 13 package.json — thiếu một cái là hỏng, kể
# cả những gói app này không đụng tới.
#
# .npmrc trỏ scope @gis vào Nexus nội bộ 10.0.0.21:8081. Copy vào cho khớp môi
# trường phát triển, NHƯNG bản build này không cần mạng LAN: cả ba gói @gis đều
# phân giải bằng liên kết `workspace:`, không tải gì từ đó.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/demo-3d-react/package.json                                 apps/demo-3d-react/
COPY apps/demo-gl-js/package.json                                    apps/demo-gl-js/
COPY apps/demo-sdk-js/package.json                                   apps/demo-sdk-js/
COPY apps/demo-sdk-react/package.json                                apps/demo-sdk-react/
COPY packages/gtelmaps-client-js/package.json                        packages/gtelmaps-client-js/
COPY packages/gtelmaps-gl-js/package.json                            packages/gtelmaps-gl-js/
COPY packages/gtelmaps-sdk-js/package.json                           packages/gtelmaps-sdk-js/
COPY packages/gtelmaps-style-spec/package.json                       packages/gtelmaps-style-spec/
COPY packages/gtelmaps-sdk-react/package.json                        packages/gtelmaps-sdk-react/
COPY packages/gtelmaps-sdk-react/modules/main/package.json           packages/gtelmaps-sdk-react/modules/main/
COPY packages/gtelmaps-sdk-react/modules/react-gtelmaps/package.json packages/gtelmaps-sdk-react/modules/react-gtelmaps/
COPY packages/gtelmaps-sdk-react/modules/react-mapbox/package.json   packages/gtelmaps-sdk-react/modules/react-mapbox/
COPY packages/gtelmaps-sdk-react/modules/react-maplibre/package.json packages/gtelmaps-sdk-react/modules/react-maplibre/

# Hậu tố `...` = gói này VÀ các phụ thuộc của nó. Nó bỏ qua devDependencies
# khổng lồ của fork gl-js (puppeteer, rollup, ts-node) nhưng vẫn cài
# `dependencies` của gói ấy — `tsc` cần chúng, vì dist/gtelmaps-gl.d.ts import
# @mapbox/point-geometry, @mapbox/tiny-sdf và @maplibre/geojson-vt.
#
# `--ignore-scripts` là BẮT BUỘC ở đây, không phải để chạy nhanh. Stage này mới
# chỉ có package.json của các gói workspace chứ chưa có mã nguồn của chúng, mà
# pnpm vẫn chạy `prepare` cho gói workspace:
#
#   packages/gtelmaps-client-js  prepare: prettier --write "src/**/*.{js,ts,tsx}"
#     → [error] No files matching the pattern were found: "src/**/*.{js,ts,tsx}"
#   packages/gtelmaps-gl-js      prepare: npm run codegen
#
# Cả hai đều dựng lại chính gói của mình, thứ image này KHÔNG dựng lại — nó chép
# dist/ có sẵn ở ngay dưới. Bỏ qua script cũng không mất gì cho app: react,
# vite, typescript và esbuild đều không có script cài đặt (nhị phân của esbuild
# và rollup đến từ optionalDependencies theo nền tảng, không phải từ postinstall).
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter demo-3d-react...

# Artefact dựng sẵn, chép đúng thứ app chạm tới và không hơn.
#
#   gtelmaps-gl-dev.js  src/gl.ts import thẳng đường dẫn con này. PHẢI là bản
#                       -dev: dist/gtelmaps-gl.js cũ hơn và thiếu vài layer 3D.
#   gtelmaps-gl.css     src/main.tsx nhập, và phải nhập TRƯỚC styles.css.
#   gtelmaps-gl.d.ts    `types` của gói; tsc --noEmit cần.
#   dist/package.json   để phân giải đường dẫn con.
#
# Bỏ qua *-csp*, *three*, bench-* và mọi *.map: 58 MB trong 63 MB của dist, không
# đường nào trong app chạm tới.
COPY packages/gtelmaps-gl-js/dist/gtelmaps-gl-dev.js \
     packages/gtelmaps-gl-js/dist/gtelmaps-gl.css \
     packages/gtelmaps-gl-js/dist/gtelmaps-gl.d.ts \
     packages/gtelmaps-gl-js/dist/package.json \
     packages/gtelmaps-gl-js/dist/

# Gói React và chuỗi type của nó: react-gtelmaps/dist/*.d.ts chỉ import ra ngoài
# hai chỗ — 'react' và '@gis/gtelmaps-sdk-js'.
COPY packages/gtelmaps-sdk-react/modules/react-gtelmaps/dist packages/gtelmaps-sdk-react/modules/react-gtelmaps/dist
COPY packages/gtelmaps-sdk-js/dist                           packages/gtelmaps-sdk-js/dist

# Mã nguồn app. `public/` bị Dockerfile.dockerignore chặn, và đó là chủ ý: Vite
# thấy publicDir không tồn tại thì bỏ qua bước chép, nên 31 MB không lọt vào
# dist/ để rồi bị volume che đi.
COPY apps/demo-3d-react apps/demo-3d-react

# `tsc --noEmit && vite build` → apps/demo-3d-react/dist.
RUN pnpm --filter demo-3d-react build

# ---- Stage 2: runtime (nginx) ----------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Cấu hình phục vụ HAI gốc thư mục: bản build ở /usr/share/nginx/html, dữ liệu
# tĩnh ở /srv/public. Và trả 404 — không phải index.html — cho tile không có.
COPY apps/demo-3d-react/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/demo-3d-react/dist /usr/share/nginx/html

# Điểm mount cho public/. Tạo sẵn để container vẫn lên được khi quên mount —
# lúc ấy trang hiện ra nhưng bản đồ trắng, dễ chẩn đoán hơn là nginx không khởi
# động nổi.
RUN mkdir -p /srv/public

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
