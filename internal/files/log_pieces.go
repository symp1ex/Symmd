package files

import (
	"errors"
	"io"
	"os"
)

// A persistent implicit treap keeps logical offsets independent of file size.
// Nodes and old roots are retained only for edit history; inserted bytes live
// in an append-only file, never in the history nodes.
type logPiece struct {
	add    bool
	offset int64
	length int64
}

type logNode struct {
	piece    logPiece
	left     *logNode
	right    *logNode
	length   int64
	priority uint64
}

func logLength(n *logNode) int64 {
	if n == nil {
		return 0
	}
	return n.length
}

func logNodeCopy(n *logNode, left, right *logNode) *logNode {
	copy := *n
	copy.left, copy.right = left, right
	copy.length = logLength(left) + copy.piece.length + logLength(right)
	return &copy
}

func (e *logEntry) newLogNode(piece logPiece) *logNode {
	e.seed += 0x9e3779b97f4a7c15
	z := e.seed
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return &logNode{piece: piece, length: piece.length, priority: z ^ (z >> 31)}
}

func mergeLog(left, right *logNode) *logNode {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if left.priority >= right.priority {
		return logNodeCopy(left, left.left, mergeLog(left.right, right))
	}
	return logNodeCopy(right, mergeLog(left, right.left), right.right)
}

func (e *logEntry) splitLog(root *logNode, offset int64) (*logNode, *logNode) {
	if root == nil {
		return nil, nil
	}
	leftLength := logLength(root.left)
	if offset <= leftLength {
		left, right := e.splitLog(root.left, offset)
		return left, logNodeCopy(root, right, root.right)
	}
	if offset >= leftLength+root.piece.length {
		left, right := e.splitLog(root.right, offset-leftLength-root.piece.length)
		return logNodeCopy(root, root.left, left), right
	}
	part := offset - leftLength
	first := e.newLogNode(logPiece{root.piece.add, root.piece.offset, part})
	second := e.newLogNode(logPiece{root.piece.add, root.piece.offset + part, root.piece.length - part})
	return mergeLog(root.left, first), mergeLog(second, root.right)
}

func readLogTree(root *logNode, original, add *os.File, buffer []byte, offset int64) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if offset < 0 {
		return 0, errors.New("negative log offset")
	}
	if offset >= logLength(root) {
		return 0, io.EOF
	}
	read := 0
	var walk func(*logNode, int64) error
	walk = func(node *logNode, base int64) error {
		if node == nil || read == len(buffer) || base >= offset+int64(len(buffer)) || base+node.length <= offset {
			return nil
		}
		if err := walk(node.left, base); err != nil {
			return err
		}
		pieceStart := base + logLength(node.left)
		from := max(offset, pieceStart)
		to := min(offset+int64(len(buffer)), pieceStart+node.piece.length)
		if from < to {
			source := original
			if node.piece.add {
				source = add
			}
			if source == nil {
				return errors.New("log backing store is closed")
			}
			n, err := source.ReadAt(buffer[read:read+int(to-from)], node.piece.offset+from-pieceStart)
			read += n
			if err != nil && err != io.EOF {
				return err
			}
			if int64(n) != to-from {
				return io.ErrUnexpectedEOF
			}
		}
		return walk(node.right, pieceStart+node.piece.length)
	}
	if err := walk(root, 0); err != nil {
		return read, err
	}
	if read < len(buffer) {
		return read, io.EOF
	}
	return read, nil
}
