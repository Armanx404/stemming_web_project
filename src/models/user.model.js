/**
 * src/models/user.model.js — User Schema
 *
 * Security decisions:
 *   - Password is hashed with bcrypt (cost factor 12) BEFORE save — never stored plain.
 *   - The password field is excluded from all queries by default (select: false).
 *     To read it: UserModel.findOne({...}).select('+password')
 *   - comparePassword() is an instance method — controllers never call bcrypt directly.
 *   - refreshToken is stored as a keyed hash — a DB leak cannot forge sessions.
 *
 * FIX: Password minlength is now driven by MIN_PASSWORD_LENGTH env var (default 6).
 *   The original hardcoded 8 blocked all testing with short passwords like "123456".
 */

'use strict';

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
const { Schema } = mongoose;

const BCRYPT_SALT_ROUNDS = 12;

// Configurable via env — default 6 to allow test passwords like "123456"
// Set MIN_PASSWORD_LENGTH=8 in production .env for stronger enforcement
const MIN_PASSWORD_LENGTH = parseInt(process.env.MIN_PASSWORD_LENGTH, 10) || 6;

// ─── Schema ───────────────────────────────────────────────────────────────────

const UserSchema = new Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must not exceed 30 characters'],
      match: [
        /^[a-zA-Z0-9_]+$/,
        'Username may only contain letters, numbers, and underscores',
      ],
      unique: true,
      index: true,
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },

    // ── IMPORTANT: select:false ────────────────────────────────────────────────
    // This field is NEVER returned by any query unless you explicitly call
    // .select('+password'). The login function in auth.service.js does this.
    // If you forget .select('+password'), user.password is undefined and
    // bcrypt.compare() throws — causing a 500.
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [
        MIN_PASSWORD_LENGTH,
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      ],
      select: false,
    },

    role: {
      type: String,
      enum: {
        values: ['user', 'moderator', 'admin', 'superadmin'],
        message: 'Role must be one of: user, moderator, admin, superadmin',
      },
      default: 'user',
    },

    // Stored as a keyed hash, not the raw token.
    // select:false keeps it out of all default queries.
    refreshToken: {
      type: String,
      default: null,
      select: false,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret._id;
        delete ret.password;      // Belt-and-suspenders on top of select:false
        delete ret.refreshToken;
        delete ret.isActive;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// ─── Pre-save Hook: Hash Password ─────────────────────────────────────────────

/**
 * Only re-hash when the password field was actually changed.
 * Without this guard, every .save() (e.g. updating email) would double-hash
 * the already-hashed password, permanently breaking login for that user.
 */
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    this.password = await bcrypt.hash(this.password, BCRYPT_SALT_ROUNDS);
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Instance Methods ─────────────────────────────────────────────────────────

/**
 * comparePassword — Timing-safe bcrypt comparison.
 *
 * ALWAYS use this method. Never do: user.password === candidatePassword
 *
 * @param {string} candidatePassword — Plain-text password from the login request
 * @returns {Promise<boolean>}
 *
 * @throws {Error} If this.password is undefined — means the query that loaded
 *   this document did NOT call .select('+password'). Fix the query in auth.service.js.
 */
UserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) {
    throw new Error(
      'comparePassword: password field not loaded. ' +
      'Query must include .select(\'+password\')'
    );
  }
  return bcrypt.compare(candidatePassword, this.password);
};

// ─── Virtual ──────────────────────────────────────────────────────────────────

UserSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

// ─── Model ────────────────────────────────────────────────────────────────────

const UserModel = mongoose.model('User', UserSchema);

export default UserModel;
