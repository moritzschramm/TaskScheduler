package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

// ! rules for using session:
// If a controller wants to read/write from/to the session, the path should .Use(..) this middleware
// The session is injected into the request context via c.Locals(middleware.SessionKey)
// If a service needs to write to the session, the controller should pass it from the local context
// The service should _not_ save the changes, that is the responsibility of the controller at the end of a function
// The reason for this is, that multiple reads/writes can happen

// keys that are used IN the session (not in c.Locals(..))
const (
	TemporaryUserKey = "TemporaryUserKey"
	UserKey          = "UserKey"
)

// all keys for c.Locals(..) should use this type (not IN session)
type LocalsKeyType struct{}

var SessionKey LocalsKeyType

// this error message can be used in a handler when retrieving the session via c.Locals(..) fails
var SessionError = &fiber.Error{Code: 500, Message: "Session error"}
var SessionKeyError = &fiber.Error{Code: 500, Message: "Session key error"}

// retrieve session from store; session is available with c.Locals(middleware.SessionKey)
func SessionMiddleware(store *session.Store) func(*fiber.Ctx) error {

	return func(c *fiber.Ctx) error {

		session, err := store.Get(c)
		if err != nil {
			return err
		}

		// inject session to request
		c.Locals(SessionKey, session)

		return c.Next()
	}
}
