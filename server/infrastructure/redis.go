package infrastructure

import (
	"context"
	"log"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisStore struct {
	db              redis.UniversalClient
	syncOnConnected *sync.WaitGroup
}

func NewKeyValueStore(syncOnConnected *sync.WaitGroup) Store {
	syncOnConnected.Add(1)
	return &RedisStore{
		syncOnConnected: syncOnConnected,
	}
}

func (r *RedisStore) Open(addr string) {
	r.db = redis.NewClient(&redis.Options{
		Addr:     addr,
		DB:       0,
		Password: "",
	})

	err := r.db.Ping(context.Background()).Err()
	if err != nil {
		log.Fatalf("Error while trying to establish a connection to Redis: %v\n", err)
		os.Exit(1)
	} else {
		log.Println("Redis connection successful")
		r.syncOnConnected.Done()
	}
}

func (r *RedisStore) Get(key string) ([]byte, error) {
	if len(key) <= 0 {
		return nil, nil
	}
	val, err := r.db.Get(context.Background(), key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	return val, err
}

// * set exp to `0` for no expiration time
func (r *RedisStore) Set(key string, val []byte, exp time.Duration) error {
	if len(key) <= 0 || len(val) <= 0 {
		return nil
	}
	return r.db.Set(context.Background(), key, val, exp).Err()
}

func (r *RedisStore) Delete(key string) error {
	if len(key) <= 0 {
		return nil
	}
	return r.db.Del(context.Background(), key).Err()
}

func (r *RedisStore) Reset() error {
	return r.db.FlushDB(context.Background()).Err()
}

func (r *RedisStore) Close() error {
	return r.db.Close()
}

func (r *RedisStore) Keys() ([][]byte, error) {
	var keys [][]byte
	var cursor uint64
	var err error

	for {
		var batch []string

		if batch, cursor, err = r.db.Scan(context.Background(), cursor, "*", 10).Result(); err != nil {
			return nil, err
		}

		for _, key := range batch {
			keys = append(keys, []byte(key))
		}

		if cursor == 0 {
			break
		}
	}

	if len(keys) == 0 {
		return nil, nil
	}

	return keys, nil
}
