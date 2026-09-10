# Triển khai upload/download ảnh ChatGPT Web

Ngày kiểm chứng: 10/09/2026.

**Trạng thái: đã triển khai và kiểm chứng tự động trên source cùng Electron fixture. Chưa nghiệm thu live trên ChatGPT sau khi người dùng nạp runtime mới.**

## Luồng đã triển khai

Giữ parent Temporary Chat → cuộc hội thoại thường trong Image Factory đã có → artifact trong workspace. Public tool schema giữ nguyên. Không thêm thao tác tự tạo project hoặc fallback sang Codex ImageGen.

Download đi qua các bước: bind đúng assistant/card → kích hoạt phần ảnh → xác nhận viewer và ảnh đang được chọn → tìm Download trong viewer/menu có quan hệ sở hữu → lấy bytes gốc → kiểm tra MIME/kích thước → lưu artifact và manifest. Preview `imageSrc` chỉ dùng nhận diện, không dùng làm nguồn ảnh gốc. Những link original/download rõ ràng được xử lý riêng với kiểm tra nguồn và redirect.

Viewer được kiểm tra lại sau khi đăng ký giao dịch download, ngay trước click. Một thumbnail trùng ảnh không đủ chứng minh viewer đang chọn đúng ảnh. Dialog được remount không được giữ lại hai binding. Chỉ retry có giới hạn với lỗi bind tạm thời trước click; không replay click download đã phát hoặc gửi lại prompt tạo ảnh.

Launcher sở hữu giao dịch download theo `traceId`, `helperPid`, `surfaceId`, target CDP, `jobId`, `candidateKey` và `transactionId`. Helper đăng ký qua control channel có xác thực trước click. Trong `will-download`, Launcher đặt đường dẫn tạm đồng bộ bằng `setSavePath`, theo dõi hoàn thành/hủy/quá giới hạn, rồi dọn file và listener. Những download ngoài giao dịch không bị đổi hành vi. Hai tab/job khác nhau có thể tải đồng thời; giao dịch chồng lấn trên cùng tab bị từ chối.

Capture có một deadline chung cho các thao tác đang chạy, bao gồm kiểm tra target CDP. Cancellation đi xuyên suốt. Cleanup vẫn được thực hiện sau hủy bằng ngân sách riêng có giới hạn, trong đó control release tối đa 5 giây và detach CDP tối đa 2 giây. Lỗi cleanup không thay thế lỗi chính. Bản sửa thêm giữ nguyên nguyên nhân timeout/cancellation khi API timer hoặc trình duyệt bọc nó thành `AbortError`.

Upload theo dõi số reference và trạng thái từng attachment. Mọi reference phải có tile đúng tên và trạng thái sẵn sàng, không có dấu hiệu pending/lỗi, cùng nút Send khả dụng qua hai lần quan sát. Với UI không có trạng thái upload rõ ràng, kiểm tra chip có control khả dụng và preview ảnh đã tải, không phụ thuộc chữ trên nút Remove. Đây là bằng chứng từ UI; fixture không chứng minh được backend ChatGPT thực tế đã nhận file. Worker kiểm tra lại reference cả trước và sau `onSendActivated`, đồng thời kiểm tra cancellation ngay trước Send.

Log transfer ghi phiên bản, hash entrypoint helper được chụp khi module tải, job/trace, từng bước và lỗi gốc đã lọc dữ liệu nhạy cảm. Không đưa signed URL, cookie hoặc bytes ảnh vào log/control payload.

## Các file chính

| Thành phần | File |
| --- | --- |
| Deadline, cancellation, log đã lọc dữ liệu | `src/adapters/chatgpt-web/image-transfer.ts` |
| Upload và readiness guard trước Send | `src/adapters/chatgpt-web/file-attachments.ts`, `browser-worker.ts` |
| Nhận diện viewer/ảnh và download | `src/adapters/chatgpt-web/artifacts/image/image-viewer.ts`, `image-downloader.ts` |
| Protocol giao dịch helper–Launcher | `src/adapters/chatgpt-web/artifacts/image/download-transaction.ts` |
| Sở hữu và dọn download trong Electron | `launcher/electron/image-downloads.cjs`, `browser-host.cjs`, `control-server.cjs` |
| Kiểm tra runtime trước khi gửi prompt | `browser-helper-main.ts`, `launcher-helper-client.ts`, `src/launcher-browser-host.ts` |
| Capture, MIME, persistence và manifest | `src/adapters/chatgpt-web/artifacts/image/output-image-adapter.ts` |

## Kết quả kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| `bun test ./tests` | 726 pass, 1 skip, 0 fail; 727 test trên 53 file |
| `bun run launcher:test` | 306 pass, 1 skip, 0 fail |
| `bun run test:image-transfer:electron` | 16 pass, 0 fail |
| `bun run typecheck` | Pass |
| Bundle `browser-helper-main.ts` với target Node/CJS, packages external | Pass; 45 module |
| `node --check` trên helper vừa bundle | Pass |
| `git diff --check` | Pass |

Electron fixture dùng profile tạm riêng và HTTP server localhost; không dùng profile ChatGPT đang đăng nhập. Fixture chạy downloader, attachment guard, pre-Send worker boundary, control server và download manager thật.

Các ca kiểm chứng gồm overlay, nhiều button, menu Download có ownership, card unmount, viewer remount, ảnh lớn đang chọn khác thumbnail, nhiều ảnh lưu riêng, click chậm hơn 5 giây, download chậm, hủy khi đang tải, hủy trước khi click khả dụng, timeout chung, file vượt giới hạn, hai job song song và dọn file tạm. Upload có một/nhiều reference, chip không có state rõ ràng với nhãn tiếng Nhật, upload bị từ chối, reference bị gỡ và hủy ngay trước Send. Test kiểm tra số click/request để phát hiện download trùng.

Log của lượt kiểm chứng này và helper bundle kiểm tra được giữ trong `/tmp/codex-image-transfer-validation.AJOHvA/`. Đây là output kiểm chứng tạm, không phải runtime đã được cài vào app.

## Điều kiện nghiệm thu live còn lại

Người dùng cần chủ động nạp lại **cả Launcher lẫn browser helper** từ source/build mới. Refresh riêng giao diện không đủ để cập nhật main-process download handler. Launcher phải quảng bá `owned-image-download-v1`, helper phải quảng bá `image-transfer-v1`; runtime cũ bị chặn trước khi chuẩn bị/gửi prompt ảnh.

Sau khi runtime mới đã được nạp:

1. Tạo một ảnh bằng luồng Image Factory hiện có. Giữ nguyên `request_id` khi đối chiếu/retry cùng công việc; chờ job kết thúc và kiểm tra artifact thực sự đọc được.
2. Sửa ảnh đó bằng reference local, dùng `imageSessionId` được trả về làm `image_session_id`. Kiểm tra log reference thực sự được chấp nhận trước Send và artifact kết quả đọc được.
3. Đối chiếu mỗi thao tác chỉ có một prompt được gửi, download thuộc đúng tab/job, không xuất hiện hộp thoại chọn thư mục và không còn file tạm sau khi hoàn tất/hủy.

Chỉ sau khi hai lượt live đạt mới đánh dấu hoàn tất toàn bộ kế hoạch. Trong đợt triển khai này không restart/kill app đang dùng hoặc tunnel, không gửi prompt tạo/sửa ảnh lên tài khoản và không tạo commit.
