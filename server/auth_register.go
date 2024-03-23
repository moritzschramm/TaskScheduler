package main

import (
	"errors"
	"log"
	"math/big"
	"time"

	"crypto/rand"

	"github.com/alexedwards/argon2id"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/session"
)

const TMP_USER_KEY = "temp_user"
const ERROR_DESERIALIZATION_OF_USER_FAILED = "failed to deserialize *User from session storage"

type (
	registerEmailReq struct {
		Email string `json:"email" validate:"required,email,max=511"`
	}

	registerPasswordReq struct {
		Password string `json:"password" validate:"required,min=10"`
	}

	verifyEmailAndCreateUserReq struct {
		VerificationCode string `json:"verificationCode" validate:"required,len=6"`
	}
)

func RouteRegisterEmail(c *fiber.Ctx) error {

	req, err := ParseAndValidate[registerEmailReq](c)
	if err != nil {
		return err
	}

	session, err := store.Get(c)
	if err != nil {
		return err
	}

	session.Reset()
	session.SetExpiry(30 * time.Minute)

	emailExists, err := checkEmailExists(req.Email)
	if err != nil {
		return err
	}

	if emailExists {
		return c.Status(fiber.StatusUnauthorized).JSON(&fiber.Map{
			"email": "Email already exists.",
		})
	}

	err = setRegisterEmail(req.Email, session)
	if err != nil {
		return err
	}

	err = session.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func RouteRegisterPassword(c *fiber.Ctx) error {

	req, err := ParseAndValidate[registerPasswordReq](c)
	if err != nil {
		return err
	}

	session, err := store.Get(c)
	if err != nil {
		return err
	}

	err = setRegisterPassword(req.Password, session)
	if err != nil {
		return err
	}

	err = session.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusCreated)
}

func RouteVerifyEmailAndCreateUser(c *fiber.Ctx) error {

	req, err := ParseAndValidate[verifyEmailAndCreateUserReq](c)
	if err != nil {
		return err
	}

	session, err := store.Get(c)
	if err != nil {
		return err
	}

	verified, user, err := verifyEmailAndGetTempUser(req.VerificationCode, session)
	if err != nil {
		return err
	}

	if !verified {
		return c.Status(fiber.StatusForbidden).JSON(&fiber.Map{
			"err": "Wrong verification code.",
		})
	}

	err = createUser(user)
	if err != nil {
		return err
	}

	session.Reset()
	err = session.Save()
	if err != nil {
		return err
	}

	return c.SendStatus(fiber.StatusOK)
}

func setRegisterEmail(email string, sess *session.Session) error {

	code, err := generateVerificationCode()
	if err != nil {
		return err
	}

	// ! TODO remove in prod
	log.Printf("Email code is %v\n", code)
	// TODO send email

	hashedCode, err := argon2id.CreateHash(code, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	user := &User{
		Email:                email,
		VerificationCodeHash: hashedCode,
	}

	sess.Set(TMP_USER_KEY, user)

	return nil
}

func setRegisterPassword(password string, sess *session.Session) error {

	hashedPassword, err := argon2id.CreateHash(password, argon2id.DefaultParams)
	if err != nil {
		return err
	}

	user, ok := sess.Get(TMP_USER_KEY).(*User)
	if !ok {
		return errors.New(ERROR_DESERIALIZATION_OF_USER_FAILED)
	}

	user.PasswordHash = hashedPassword

	sess.Set(TMP_USER_KEY, user)

	return nil
}

func verifyEmailAndGetTempUser(code string, sess *session.Session) (bool, *User, error) {
	// TODO save IP to block after 3 attempts -> in service

	user, ok := sess.Get(TMP_USER_KEY).(*User)
	if !ok {
		return false, nil, errors.New(ERROR_DESERIALIZATION_OF_USER_FAILED)
	}

	match, err := argon2id.ComparePasswordAndHash(code, user.VerificationCodeHash)
	if err != nil {
		return false, nil, err
	}

	if !match {
		return false, nil, nil
	}

	return true, user, nil
}

func generateVerificationCode() (string, error) {
	const letters = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
	const length = 6
	ret := make([]byte, length)
	for i := 0; i < length; i++ {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			return "", err
		}
		ret[i] = letters[num.Int64()]
	}

	return string(ret), nil
}

func checkEmailExists(email string) (bool, error) {

	var exists bool
	err := db.QueryRow("select count(*) > 0 from users as u where u.email=$1", email).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

func createUser(user *User) error {

	return db.Exec("insert into users (email, name, passwordhash) values ($1, $2, $3)",
		user.Email,
		user.Name,
		user.PasswordHash,
	)
}

/*func deleteUser(id string) error {

	return db.Exec("delete from users where id=$1", id)
}

func queryUser() *User {

	var email string
	var firstname string
	var lastname string
	err := db.QueryRow(context.Background(), "select email, firstname, lastname from users where firstname=$1", "tester").Scan(&email, &firstname, &lastname)
	if err != nil {
		fmt.Fprintf(os.Stderr, "QueryRow failed: %v\n", err)
		os.Exit(1)
	}

	return &User{
		email,
		firstname,
		lastname,
	}
}
*/
