#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_RECORDS 1000
#define MAX_LEN 1024
#define MAX_TOKENS 16

typedef struct {
    int id;
    char title[256];
    char category[128];
    char snippet[MAX_LEN];
    int score;
} Record;

static Record records[MAX_RECORDS];
static int record_count = 0;

static void to_lower_copy(const char *src, char *dst, size_t max_len) {
    size_t i = 0;
    for (; src[i] && i + 1 < max_len; i++) {
        dst[i] = (char)tolower((unsigned char)src[i]);
    }
    dst[i] = '\0';
}

static void trim_newline(char *s) {
    size_t len = strlen(s);
    while (len > 0 && (s[len - 1] == '\n' || s[len - 1] == '\r')) {
        s[--len] = '\0';
    }
}

static void print_json_escaped(const char *s) {
    putchar('"');
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"') fputs("\\\"", stdout);
        else if (c == '\\') fputs("\\\\", stdout);
        else if (c == '\n') fputs("\\n", stdout);
        else if (c == '\r') fputs("\\r", stdout);
        else if (c == '\t') fputs("\\t", stdout);
        else if (c >= 32) putchar(c);
    }
    putchar('"');
}

static void load_corpus(const char *filename) {
    FILE *fp = fopen(filename, "r");
    if (!fp) return;

    char line[MAX_LEN];
    int current = -1;

    while (fgets(line, sizeof(line), fp)) {
        trim_newline(line);
        if (strncmp(line, "[TITLE]", 7) == 0) {
            if (record_count >= MAX_RECORDS) break;
            current = record_count++;
            memset(&records[current], 0, sizeof(Record));
            records[current].id = current + 1;
            const char *val = line + 7;
            while (*val == ' ') val++;
            strncpy(records[current].title, val, sizeof(records[current].title) - 1);
        } else if (current >= 0 && strncmp(line, "[CATEGORY]", 10) == 0) {
            const char *val = line + 10;
            while (*val == ' ') val++;
            strncpy(records[current].category, val, sizeof(records[current].category) - 1);
        } else if (current >= 0 && strncmp(line, "[SNIPPET]", 9) == 0) {
            const char *val = line + 9;
            while (*val == ' ') val++;
            strncpy(records[current].snippet, val, sizeof(records[current].snippet) - 1);
        }
    }
    fclose(fp);
}

static int score_record(const Record *r, char tokens[][64], int token_count) {
    if (token_count == 0) return 100;

    char title_l[256], cat_l[128], snip_l[MAX_LEN];
    to_lower_copy(r->title, title_l, sizeof(title_l));
    to_lower_copy(r->category, cat_l, sizeof(cat_l));
    to_lower_copy(r->snippet, snip_l, sizeof(snip_l));

    int total = 0;
    for (int i = 0; i < token_count; i++) {
        const char *tok = tokens[i];
        int tok_score = 0;
        if (strcmp(title_l, tok) == 0) tok_score += 100;
        else if (strncmp(title_l, tok, strlen(tok)) == 0) tok_score += 75;
        else if (strstr(title_l, tok) != NULL) tok_score += 55;

        if (strstr(cat_l, tok) != NULL) tok_score += 30;
        if (strstr(snip_l, tok) != NULL) tok_score += 15;

        if (tok_score == 0) return 0;
        total += tok_score;
    }
    int avg = total / token_count;
    return avg > 99 ? 99 : avg;
}

static int cmp_records(const void *a, const void *b) {
    const Record *ra = *(const Record *const *)a;
    const Record *rb = *(const Record *const *)b;
    if (rb->score != ra->score) return rb->score - ra->score;
    return strcmp(ra->title, rb->title);
}

int main(int argc, char *argv[]) {
    const char *query = "";
    const char *category_filter = "";

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--category") == 0 && i + 1 < argc) {
            category_filter = argv[++i];
        } else if (query[0] == '\0') {
            query = argv[i];
        }
    }

    load_corpus("sports_corpus.txt");

    char q_buf[512];
    to_lower_copy(query, q_buf, sizeof(q_buf));

    char tokens[MAX_TOKENS][64];
    int token_count = 0;
    char *tok = strtok(q_buf, " \t\n\r");
    while (tok && token_count < MAX_TOKENS) {
        strncpy(tokens[token_count], tok, 63);
        tokens[token_count][63] = '\0';
        token_count++;
        tok = strtok(NULL, " \t\n\r");
    }

    char cat_filter_l[128];
    to_lower_copy(category_filter, cat_filter_l, sizeof(cat_filter_l));

    Record *matches[MAX_RECORDS];
    int match_count = 0;

    for (int i = 0; i < record_count; i++) {
        if (cat_filter_l[0] != '\0' && strcmp(cat_filter_l, "all") != 0) {
            char rec_cat_l[128];
            to_lower_copy(records[i].category, rec_cat_l, sizeof(rec_cat_l));
            if (strcmp(rec_cat_l, cat_filter_l) != 0) continue;
        }
        int sc = score_record(&records[i], tokens, token_count);
        if (sc > 0) {
            records[i].score = sc;
            matches[match_count++] = &records[i];
        }
    }

    qsort(matches, (size_t)match_count, sizeof(Record *), cmp_records);

    putchar('[');
    for (int i = 0; i < match_count; i++) {
        if (i > 0) putchar(',');
        printf("{\"id\":%d,\"score\":%d,\"title\":", matches[i]->id, matches[i]->score);
        print_json_escaped(matches[i]->title);
        fputs(",\"category\":", stdout);
        print_json_escaped(matches[i]->category);
        fputs(",\"snippet\":", stdout);
        print_json_escaped(matches[i]->snippet);
        putchar('}');
    }
    puts("]");
    return 0;
}
