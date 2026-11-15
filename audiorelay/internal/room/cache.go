package room

import "sync"

// retxCache keeps the most recent audio frames of one sender so the relay can
// answer NACKs without involving the sender (whose uplink is the scarce
// resource). 512 slots cover 1.28 s at 2.5 ms frames or 5 s at 10 ms frames —
// more than the 500 ms the protocol promises.
const cacheSlots = 512

type cacheEntry struct {
	seq   uint32
	valid bool
	frags [][]byte // index = FragIdx; nil until that fragment arrived
}

type retxCache struct {
	mu    sync.Mutex
	slots [cacheSlots]cacheEntry
}

// put stores a copy of one audio packet (whole frame or fragment).
func (c *retxCache) put(seq uint32, fragIdx, fragCnt uint8, pkt []byte) {
	cp := make([]byte, len(pkt))
	copy(cp, pkt)
	c.mu.Lock()
	defer c.mu.Unlock()
	e := &c.slots[seq%cacheSlots]
	if !e.valid || e.seq != seq || len(e.frags) != int(fragCnt) {
		e.seq = seq
		e.valid = true
		e.frags = make([][]byte, fragCnt)
	}
	e.frags[fragIdx] = cp
}

// get returns copies of all stored fragments of seq (nil if not cached).
func (c *retxCache) get(seq uint32) [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := &c.slots[seq%cacheSlots]
	if !e.valid || e.seq != seq {
		return nil
	}
	out := make([][]byte, 0, len(e.frags))
	for _, f := range e.frags {
		if f == nil {
			continue
		}
		cp := make([]byte, len(f))
		copy(cp, f)
		out = append(out, cp)
	}
	return out
}
