package zotlet;

/** An error whose message is meant for the user, with the HTTP status the API answers with. */
public class UserError extends RuntimeException {
    public final int status;

    public UserError(String message) { this(message, 400); }

    public UserError(String message, int status) {
        super(message);
        this.status = status;
    }
}
