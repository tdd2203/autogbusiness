"""
sepay/store.py — Kho lưu idempotency (chống cộng tiền đúp).

SePay CÓ THỂ bắn lại cùng 1 giao dịch nhiều lần. Bắt buộc phải nhớ txn đã xử lý.
Interface `IdemStore` chỉ cần 2 method. Có sẵn bản in-memory (test/1 process) và
gợi ý bản Mongo/Redis cho production.
"""

from typing import Protocol


class IdemStore(Protocol):
    def seen(self, key: str) -> bool:
        """True nếu key này đã xử lý trước đó."""
        ...

    def mark(self, key: str) -> None:
        """Ghi nhận key đã xử lý."""
        ...


class InMemoryStore:
    """Chỉ dùng cho test / 1 process. Mất khi restart → KHÔNG dùng production."""

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def seen(self, key: str) -> bool:
        return key in self._seen

    def mark(self, key: str) -> None:
        self._seen.add(key)


class MongoStore:
    """
    Bản production gợi ý. Truyền vào 1 pymongo collection.
    Tự tạo unique index trên `key` để chống race giữa nhiều webhook đồng thời.
    """

    def __init__(self, collection) -> None:
        self.col = collection
        self.col.create_index("key", unique=True)

    def seen(self, key: str) -> bool:
        return self.col.find_one({"key": key}) is not None

    def mark(self, key: str) -> None:
        try:
            self.col.insert_one({"key": key})
        except Exception:
            pass  # duplicate key = đã có, bỏ qua
