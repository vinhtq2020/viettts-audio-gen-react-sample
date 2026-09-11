/**
 * Hash chuỗi đơn giản (djb2). Không cần bảo mật — chỉ cần ổn định
 * (cùng input luôn ra cùng output) và đủ phân biệt để làm cache key.
 * Dùng để thay cho Date.now() trong cache key cũ (vốn khiến mỗi lần
 * tạo audio đều sinh key mới, không bao giờ tra lại được cache).
 */
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
