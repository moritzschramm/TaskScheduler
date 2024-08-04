package main

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/gofiber/fiber/v2"

	"github.com/go-playground/validator/v10"
)

var internalValidationErrorMsg = make(map[string]string)
var internalCamelCaseToSpaceRegex = regexp.MustCompile("([a-z])([A-Z])")

func init() {
	internalValidationErrorMsg["required"] = "{field} is required."
	internalValidationErrorMsg["min"] = "{field} needs to at least {param} characters long."
	internalValidationErrorMsg["max"] = "{field} can not be more than {param} characters long."
	internalValidationErrorMsg["len"] = "{field} needs to be exactly {param} characters long."
	internalValidationErrorMsg["email"] = "Field needs to be an email."
	internalValidationErrorMsg["uuid4"] = "{field} needs to be a UUIDv4."
}

func GlobalErrorHandler(c *fiber.Ctx, err error) error {

	if validationErrors, ok := err.(validator.ValidationErrors); ok {

		errMsg := make(map[string]string)

		for _, err := range validationErrors {

			// make first letter lowercase (err.Field does not use json tag value, even if docs say otherwise...)
			jsonField := []rune(err.Field())
			jsonField[0] = unicode.ToLower(jsonField[0])

			errMsg[string(jsonField)] = GetValidationErrorMsg(err.StructField(), err.Tag(), err.Param())
		}

		return c.Status(fiber.StatusBadRequest).JSON(errMsg)
	}

	return c.Status(fiber.StatusBadRequest).JSON(&fiber.Map{
		"err": "Error while processing request.",
	})
}

func GetValidationErrorMsg(field, tag, param string) string {

	readableField := internalCamelCaseToSpaceRegex.ReplaceAllString(field, "$1 $2")

	var r *strings.Replacer
	if param != "" {
		r = strings.NewReplacer("{field}", readableField, "{param}", param)
	} else {
		r = strings.NewReplacer("{field}", readableField)
	}

	msg, exists := internalValidationErrorMsg[tag]

	if exists {
		return r.Replace(msg)
	} else {
		return tag
	}
}
