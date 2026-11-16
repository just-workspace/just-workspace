// SPSC(단일 생산자·단일 소비자) 락프리 바이트 링버퍼 — 오디오 스레드 ↔ JS(메인) 스레드 사이.
// 생산자만 write 를, 소비자만 read 를 호출한다. 용량은 2의 거듭제곱으로 올림한다. 가득 차면 기록하지 않고 0 을 반환한다(드롭은 호출자가 집계).
#pragma once
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

class RingBuffer {
 public:
  explicit RingBuffer(size_t capacity) {
    size_t cap = 1;
    while (cap < capacity) cap <<= 1;
    buf_.resize(cap);
    mask_ = cap - 1;
  }

  size_t capacity() const { return buf_.size(); }

  // 읽기 가능한 바이트 수
  size_t available() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
  }
  size_t space() const { return buf_.size() - available(); }

  // 생산자. 전부 기록할 수 없으면 일절 기록하지 않는다(프레임 단위 원자성).
  size_t write(const uint8_t* src, size_t n) {
    const uint64_t head = head_.load(std::memory_order_relaxed);
    const uint64_t tail = tail_.load(std::memory_order_acquire);
    if (buf_.size() - (head - tail) < n) return 0;
    const size_t off = static_cast<size_t>(head & mask_);
    const size_t first = std::min(n, buf_.size() - off);
    std::memcpy(buf_.data() + off, src, first);
    if (n > first) std::memcpy(buf_.data(), src + first, n - first);
    head_.store(head + n, std::memory_order_release);
    return n;
  }

  // 소비자. 가용한 만큼(최대 n) 읽는다.
  size_t read(uint8_t* dst, size_t n) {
    const uint64_t tail = tail_.load(std::memory_order_relaxed);
    const uint64_t head = head_.load(std::memory_order_acquire);
    const size_t avail = static_cast<size_t>(head - tail);
    if (n > avail) n = avail;
    if (n == 0) return 0;
    const size_t off = static_cast<size_t>(tail & mask_);
    const size_t first = std::min(n, buf_.size() - off);
    std::memcpy(dst, buf_.data() + off, first);
    if (n > first) std::memcpy(dst + first, buf_.data(), n - first);
    tail_.store(tail + n, std::memory_order_release);
    return n;
  }

  // 소비자 측에서 폐기한다(언더런 후 재프라이밍 등)
  size_t discard(size_t n) {
    const uint64_t tail = tail_.load(std::memory_order_relaxed);
    const uint64_t head = head_.load(std::memory_order_acquire);
    const size_t avail = static_cast<size_t>(head - tail);
    if (n > avail) n = avail;
    tail_.store(tail + n, std::memory_order_release);
    return n;
  }

  // 양측이 정지한 상태에서만 호출한다
  void reset() {
    head_.store(0, std::memory_order_relaxed);
    tail_.store(0, std::memory_order_relaxed);
  }

 private:
  std::vector<uint8_t> buf_;
  size_t mask_ = 0;
  alignas(64) std::atomic<uint64_t> head_{0};
  alignas(64) std::atomic<uint64_t> tail_{0};
};
