# ChatGPT Chrome: follow-up và image editor — 2026-09-10

## Phạm vi và trạng thái

Kiểm tra trực tiếp Chrome bằng Computer Use và đọc DOM chỉ đọc qua browser API. Đây là kết quả nghiên cứu và thiết kế triển khai, chưa phải thay đổi runtime launcher. DOM này thuộc build `prod-c4ad2074065cc40142f2fa2e09294009480c7d3f`; không giả định mọi tài khoản hoặc Electron đều có cùng UI.

- Follow-up trong Thinking: đã gửi và xác minh phản hồi theo chỉ dẫn mới.
- Describe edits: đã gửi và xác minh ảnh kết quả bằng mắt.
- Một response có nhiều ảnh: chưa tái hiện được. Hai yêu cầu thử đều chỉ tạo một ảnh; gallery nhiều ảnh đã xác minh nhưng chứa ảnh từ nhiều response.
- Không lưu signed image URLs, cookie hoặc token trong tài liệu.

## 1. Follow-up khi Thinking

Conversation kiểm tra: https://chatgpt.com/c/6aa2ba9b-b1b0-83ec-bc4a-41d2046b79a7

Prompt đầu yêu cầu đếm cách lát bảng 12×12. Trong lúc UI hiển thị Thinking, nhập yêu cầu đổi sang 8×8 và bắt đầu đáp án bằng `FOLLOWUP-OK`. Sau khi Send, trang có user message mới, tiếp tục Thinking, và cuối cùng trả lời bắt đầu bằng `FOLLOWUP-OK` cho bảng 8×8. Đây là bằng chứng hành vi UI; không kết luận về cách backend tiếp tục hay khởi động lại suy luận nội bộ.

DOM quan sát:

```html
<div id="prompt-textarea" contenteditable="true" role="textbox"
     aria-label="Chat with ChatGPT" aria-multiline="true" class="ProseMirror">
  <p data-placeholder="Follow up" data-empty-paragraph="true">...</p>
</div>
<button type="submit" id="composer-submit-button"
        aria-label="Send prompt" data-testid="send-button"
        aria-disabled="false">...</button>
```

Khi chưa có text, cùng ID nút có `aria-label="Stop answering"` và `data-testid="stop-button"`. Ngay sau nhập text, nút còn có thể là Stop trước khi UI cập nhật sang Send. Không click theo ID đơn lẻ hoặc giả định nhập xong là gửi được ngay.

Luồng đề xuất:

1. Bind đúng browser lease, conversation và native owner; xác minh chỉ dẫn mới nối tiếp chỉ dẫn đang chạy.
2. Ghi baseline user-message/assistant-turn identities và tạo request ID chống gửi lặp.
3. Resolve composer ngoài image dialog; chỉ ghi khi draft trống hoặc thuộc đúng request đang xử lý.
4. Focus, nhập text, đọc lại text; đợi `data-testid="send-button"` và trạng thái enabled/ARIA enabled.
5. Click Send một lần. Nếu timeout sau click, đối soát message mới trước mọi retry.
6. Xác minh user message mới đúng nội dung và bind response tương ứng; bỏ quyền phát kết quả của response cũ.
7. Hoàn tất dựa trên trạng thái response và completion actions, không chỉ việc Stop biến mất.

Code hiện tại cần phối hợp: `src/adapters/chatgpt-web/turn-execution.ts`, `getOrCreateAfterOwnerRetirement` hiện retire session cũ và dựng lại từ canonical history khi nhận native steering. Chỉ thay thao tác focus/click trong worker chưa đủ: cần chuyển quyền sở hữu stream, tool-result lineage, cancellation và replay cùng lúc. Không bỏ nhánh retirement trước khi có handoff rõ ràng và test tình huống native steering mang cả tool result cũ.

## 2. Card ảnh, ảnh trùng DOM và gallery

Conversation kiểm tra: https://chatgpt.com/g/g-p-6aa1eeecf4e88191843bc929b28c3c7a/c/6aa29314-11fc-83ec-a55b-2929e56d7c32

Card quan sát:

```html
<div id="image-<uuid>" class="group/imagegen-image ...">
  <div tabindex="0" role="button" aria-labelledby="<image-dom-id>">
    <div ...>
      <img id="<image-dom-id>" alt="Generated image: <title>" ...>
      <!-- Có thể có thêm img alt="" để trình bày cùng ảnh -->
    </div>
  </div>
</div>
```

Selector đã khớp DOM thật: `[id^="image-"][class*="imagegen-image"]`. Card nằm dưới ancestor `[data-turn-id]`; ID turn có thể là UUID hoặc `request-<conversation-id>-<ordinal>`. Không ép ID turn thành UUID.

Năm card được quan sát có năm turn riêng. Mỗi card hoàn tất có ba thẻ img, chỉ một thẻ có alt `Generated image: ...`. Đếm tất cả img sẽ đếm thừa. Card cũng xuất hiện trước khi có bất kỳ img nào, nên presence không chứng minh ảnh đã tải xong.

Gallery dùng button có accessible name `Image 1 of 5: <title>` ... `Image 5 of 5: <title>`. Tổng số gallery bao gồm các response trước; không dùng số này làm số output của job hiện tại. Ảnh chính trong viewer có alt bằng title, không có tiền tố `Generated image:`.

Code hiện tại:

- `artifacts/image/image-detector.ts`: trả array candidate theo card trong response được bind; đã có nền tảng nhiều card.
- `artifacts/image/output-image-adapter.ts`: lặp candidate, giới hạn dung lượng/số lượng, lưu từng artifact và failures.
- `artifacts/image/image-viewer.ts`: bind viewer vào candidate, đối chiếu ảnh chính để tránh nhầm thumbnail.

Điểm cần kiểm tra/cải tiến khi triển khai:

- Chọn ảnh chính theo quan hệ `aria-labelledby` của opener hoặc alt có nghĩa trước khi fallback; tránh lấy lớp img trang trí có source trước.
- Đợi card set và readiness ổn định sau response terminal. Test card thứ hai xuất hiện trễ và card chưa hydrate.
- Dedupe theo card/file identity trong phạm vi response, không theo title hay gallery index.
- DOM thực dùng file identity dạng `file_...`; hàm `fileIdentity` trong image-viewer hiện chỉ nhận `file-...`. So sánh full URL vẫn hoạt động khi URL không đổi, nhưng fallback identity có thể thất bại khi signed URL refresh.
- Thử lại với conversation thực sự có nhiều card trong cùng response trước khi tuyên bố E2E multi-image đã đạt.

## 3. Describe edits và tool đề xuất

Dialog có `role="dialog"`, `data-state="open"`, `aria-hidden="false"`, aria-label là tiêu đề ảnh. Bên trong có:

```html
<div data-testid="fullscreen-shell-body">
  <div data-testid="lightbox-new-body-surface" role="presentation">
    ...
    <form data-type="unified-composer">
      <textarea placeholder="Describe edits" style="display: none;">...</textarea>
      <div id="prompt-textarea" contenteditable="true" role="textbox"
           aria-label="Chat with ChatGPT">
        <p data-placeholder="Describe edits">...</p>
      </div>
      <button type="submit" data-testid="send-button"
              id="composer-submit-button" aria-label="Send prompt"
              aria-disabled="true">...</button>
    </form>
  </div>
</div>
```

Cùng lúc tồn tại composer chat nền và composer editor, cùng ID và accessible name. Placeholder nằm ở paragraph hoặc textarea ẩn, không phải thuộc tính placeholder của contenteditable. Không dùng `#prompt-textarea` toàn trang hoặc `getByPlaceholder` trỏ vào textarea ẩn. Resolve dialog ảnh đã xác minh identity, rồi tìm contenteditable trong form có textarea placeholder `Describe edits` hoặc paragraph tương ứng. Kiểm tra uniqueness và enabled trước khi ghi.

Thử nghiệm: chọn ảnh có vòng tròn xanh, tam giác cam và vuông xanh lá; gửi `Keep all three shapes and their positions unchanged. Change only the green square to purple.` qua editor. Trang chuyển tạm sang `/c/WEB:<id>` rồi quay lại conversation project nguồn. Xuất hiện user message kèm `Edited image`, sau đó card mới. Kiểm tra ảnh chính thấy vuông màu tím, vòng tròn xanh và tam giác cam.

Không coi URL `/c/WEB:...` tạm thời là conversation mới hoặc mất ownership. Đợi URL ổn định kết hợp bằng chứng submission. Không tái gửi nếu chưa đối soát được.

API đề xuất, chưa triển khai:

```json
{
  "name": "chatgpt_image_edit",
  "arguments": {
    "request_id": "unique-idempotent-request",
    "image_session_id": "owned-session",
    "source_artifact_id": "artifact-from-previous-result",
    "prompt": "Change only the green square to purple."
  }
}
```

Resolve artifact server-side thành conversation + assistant turn + card identity. Không cho model chọn theo vị trí gallery hoặc URL tùy ý. Reuse cơ chế owner, job/idempotency, wait/cancel và artifact capture của Image Factory. Tool trả job ID; `chatgpt_image_wait` trả các artifact mới. Lưu quan hệ source artifact → edit job → result artifacts.

Luồng: xác minh source thuộc owner/session → mở conversation và card đúng → bind image viewer → resolve Describe edits → fill/readback → Send một lần → xác nhận tin nhắn mới + URL ổn định → theo dõi response mới → tải kết quả → lưu manifest.

`image-factory/contracts.ts` hiện chỉ có generate/wait/cancel. `chatgpt_image_generate` đã nhận `image_session_id` và `reference_image_paths`, nhưng chưa có tool chọn một artifact cụ thể rồi thao tác Describe edits. `service.ts` đã chống trùng request và khóa session busy; cần dùng chung thay vì tạo job manager độc lập.

## Kiểm thử cần có khi triển khai

- Follow-up: Stop→Send chuyển chậm; gửi trong Thinking; response cũ kết thúc đồng thời; replay cùng request; timeout sau click; steering kèm tool result; cancel trong lúc handoff.
- Multi-image: hai card cùng response; img trình bày trùng; ảnh lịch sử trong gallery; card hydrate trễ; signed URL đổi; tải một ảnh lỗi phải trả partial chính xác.
- Image edit: hai composer cùng ID; sai ảnh đang được chọn; ảnh nguồn khác owner; session busy; URL WEB chuyển tiếp; send timeout; output mới không lẫn artifact nguồn.

## Thao tác đã thực hiện trên tài khoản

Đã thêm ba yêu cầu vào chat Image Factory: một edit thành công và hai bài kiểm tra nhiều ảnh (mỗi bài trả một ảnh). Đã tạo một chat kiểm tra Thinking/follow-up. Không xóa chat hay ảnh. Chưa sửa code runtime hoặc chạy test runtime vì deliverable của lượt nghiên cứu này là DOM và thiết kế luồng.
