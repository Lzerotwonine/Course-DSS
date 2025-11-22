import io
import json
import logging
from matplotlib import font_manager
import numpy as np
from flask import Flask, Response, current_app, request, jsonify, render_template, send_file, Blueprint
from pymongo import MongoClient
import datetime
import datetime
import matplotlib
matplotlib.use('Agg') 
import matplotlib.pyplot as plt 
import os
import uuid
import requests
from flask import Flask, request, jsonify
from dotenv import load_dotenv
import pandas as pd
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Image as RLImage
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.graphics.shapes import Drawing, String
from reportlab.graphics.charts.piecharts import Pie
from reportlab.platypus import Flowable
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.platypus import Table, TableStyle
from reportlab.lib import colors
import xlsxwriter
import traceback
import re

# === 1. Load ENV ===
load_dotenv()

# === 2. MongoDB setup ===
mongo_client  = MongoClient("mongodb://localhost:27017/")
db = mongo_client["CourseDB"]
collection = db["ahp_results"]
courses_coll = db["courses"]
prefs_collection = db["user_preferences"]

# === 3. Flask app ===
app = Flask(__name__, template_folder="templates")

app.config["TEMPLATES_AUTO_RELOAD"] = True

# Vừa vào web --> Vào để chọn chế độ
@app.route("/")
def home():
    return render_template('choose.html')

# Chế độ thủ công
@app.route('/manual')
def manual():
    return render_template('index.html')

# Chế độ nhập từ database
@app.route('/db')
def db_mode():
    return render_template('db.html')

# === 4. Các hàm AHP hiện có ===

def normalize_matrix(matrix):
    """Chuẩn hóa ma trận và tính trọng số AHP."""
    norm_matrix = matrix / matrix.sum(axis=0)  
    priority_vector = norm_matrix.mean(axis=1)  
    return norm_matrix, priority_vector.tolist()

def calculate_priority_vector(matrix):
    """Tính vector trọng số ưu tiên từ ma trận so sánh cặp."""
    eigenvalues, eigenvectors = np.linalg.eig(matrix)
    max_index = np.argmax(eigenvalues)                  
    priority_vector = np.real(eigenvectors[:, max_index])
    priority_vector = priority_vector / np.sum(priority_vector)
    return np.real(eigenvalues[max_index]), priority_vector.tolist()

def calculate_consistency_ratio(matrix):
    """Tính chỉ số nhất quán CI và tỷ số nhất quán CR."""
    n = matrix.shape[0]
    # Bảng chỉ số ngẫu nhiên RI của Saaty
    RI_dict = {1: 0.00, 2: 0.00, 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41, 9: 1.45}
    
    lambda_max, _ = calculate_priority_vector(matrix)
    CI = (lambda_max - n) / (n - 1)
    RI = RI_dict.get(n, 1.45)  # Dùng 1.45 cho n > 9
    CR = CI / RI if RI != 0 else 0
    
    return lambda_max, CI, CR


@app.route("/check_criteria_cr", methods=["POST"])
def check_criteria_cr():
    """API kiểm tra tỷ số nhất quán CR của ma trận tiêu chí."""
    try:
        data = request.json
        criteria_matrix = np.array(data["criteria_matrix"], dtype=np.float64)

        lambda_max, CI, CR = calculate_consistency_ratio(criteria_matrix)
        return jsonify({
            "lambda_max": lambda_max,
            "CI": CI,
            "CR": CR,
            "valid": bool(CR <= 0.1) # CR <= 0.1 là hợp lệ
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/ahp', methods=['POST'])
def ahp_api():
    """API xử lý AHP: tính trọng số và điểm tổng hợp."""
    data = request.json
    logging.debug("Dữ liệu nhận được: %s", data)

    # Kiểm tra dữ liệu đầu vào
    required_keys = ["criteria_matrix", "alternative_matrices", "alternative_names", "criteria_names"]
    for key in required_keys:
        if key not in data or not data[key]:
            return jsonify({"error": f"Thiếu dữ liệu: {key}"}), 400

    try:
        criteria_matrix = np.array(data["criteria_matrix"], dtype=np.float64)
        alternative_matrices = {key: np.array(value, dtype=np.float64) for key, value in data["alternative_matrices"].items()}
        alternative_names = data["alternative_names"] # Tên các khóa học
        criteria_names = data["criteria_names"]
    except Exception as e:
        return jsonify({"error": f"Lỗi chuyển đổi dữ liệu: {str(e)}"}), 400

    # Kiểm tra kích thước ma trận tiêu chí
    num_criteria = len(criteria_names)
    if criteria_matrix.shape != (num_criteria, num_criteria):
        return jsonify({"error": "Ma trận tiêu chí phải là ma trận vuông (n × n)"}), 400

    # Kiểm tra số lượng phương án (khóa học)
    num_alternatives = len(alternative_names)
    for key, matrix in alternative_matrices.items():
        if matrix.shape != (num_alternatives, num_alternatives):
            return jsonify({"error": f"Ma trận phương án '{key}' không hợp lệ (phải là {num_alternatives} × {num_alternatives})"}), 400

    # 1. Chuẩn hóa ma trận tiêu chí
    normalized_criteria_matrix, _ = normalize_matrix(criteria_matrix)
    
    # 2. Tính trọng số tiêu chí và kiểm tra CR
    lambda_max_criteria, criteria_weights = calculate_priority_vector(criteria_matrix)
    lambda_max_criteria, CI_criteria, CR_criteria = calculate_consistency_ratio(criteria_matrix)
    
    # Kiểm tra CR của tiêu chí
    if CR_criteria > 0.1:
        logging.warning(f"Chỉ số CR tiêu chí quá cao: {CR_criteria}")
        return jsonify({"error": "Chỉ số nhất quán CR tiêu chí quá cao, dữ liệu có thể không hợp lệ!"}), 400

    # 3. Tính trọng số phương án (khóa học) theo từng tiêu chí
    alternative_weights = {}
    alternative_eigenvalues = {}

    for key, matrix in alternative_matrices.items():
        lambda_alt, weights = calculate_priority_vector(matrix)
        alternative_weights[key] = weights
        alternative_eigenvalues[key] = lambda_alt

    # 4. Tính tổng điểm phương án (Final Score)
    alternative_weight_matrix = np.array(list(alternative_weights.values())).T
    final_scores = np.dot(alternative_weight_matrix, np.array(criteria_weights))
    
    # Ghép và sắp xếp điểm từ cao đến thấp
    final_scores_sorted = sorted(
        [{"alternative": alt, "score": score} for alt, score in zip(alternative_names, final_scores)],
        key=lambda x: x["score"],
        reverse=True
    )
    
    # 5. Kết quả trả về
    result = {
        "criteria_names": criteria_names,
        "criteria_matrix": criteria_matrix.tolist(),
        "criteria_weights": criteria_weights,
        "normalized_criteria_matrix": normalized_criteria_matrix.tolist(),
        "lambda_max_criteria": float(lambda_max_criteria),
        "CI_criteria": float(CI_criteria),
        "CR_criteria": float(CR_criteria),
        "alternative_names": alternative_names,
        "alternative_matrices": {crit: mat.tolist() for crit, mat in alternative_matrices.items()},
        "alternative_lambda_max": {k: float(v) for k, v in alternative_eigenvalues.items()},
        "CR_alternatives": {crit: float(calculate_consistency_ratio(alternative_matrices[crit])[2])
                            for crit in alternative_matrices},
        "alternative_weights": {k: [float(x) for x in weights] for k, weights in alternative_weights.items()},
        "final_scores": final_scores_sorted,
    }
    
    
    # 6. Tạo biểu đồ và lưu ảnh
    
    alternative_names_plot = [item['alternative'] for item in result['final_scores']]
    final_scores_plot = [item['score'] for item in result['final_scores']]
    unique_id = uuid.uuid4().hex[:8]
    criteria_names_plot = criteria_names
    criteria_weights_plot = criteria_weights
    alt_names = [item['alternative'] for item in final_scores_sorted]
    alt_values = [item['score'] for item in final_scores_sorted]
    
    # === 1. Biểu đồ điểm tổng hợp (Cột) ===
    final_score_filename = f'final_scores_{unique_id}.png'
    image_path = os.path.join(app.root_path, 'static', final_score_filename)
    plt.figure(figsize=(10, 6))
    plt.bar(alternative_names_plot, final_scores_plot, color='skyblue')
    plt.xlabel("Phương án")
    plt.ylabel("Điểm tổng hợp")
    plt.title("So sánh điểm tổng hợp giữa các khóa học")
    plt.grid(axis='y', linestyle='--')

    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()

    plt.savefig(image_path)
    plt.close()
    result['final_scores_image'] = f'/static/{final_score_filename}'

    # === 2. Biểu đồ cột trọng số tiêu chí ===
    criteria_weight_filename = f'criteria_weights_{unique_id}.png'
    image_path_criteria = os.path.join(app.root_path, 'static', criteria_weight_filename)
    plt.figure(figsize=(10, 6))
    
    plt.bar(criteria_names_plot, criteria_weights_plot, color='lightcoral')
    plt.xlabel("Tiêu chí")
    plt.ylabel("Trọng số")
    plt.title("Trọng số của các tiêu chí")
    plt.grid(axis='y', linestyle='--')
    plt.savefig(image_path_criteria)
    plt.close()
    result['criteria_weights_image'] = f'/static/{criteria_weight_filename}'

    # === 3. Biểu đồ tròn trọng số tiêu chí ===
    criteria_pie_filename = f'criteria_weights_pie_{unique_id}.png'
    image_path_criteria_pie = os.path.join(app.root_path, 'static', criteria_pie_filename)
    plt.figure(figsize=(8, 8))
    plt.pie(criteria_weights_plot, labels=criteria_names_plot, autopct='%1.1f%%', startangle=140)
    plt.title('Tỷ lệ trọng số của các tiêu chí')
    plt.axis('equal')
    plt.savefig(image_path_criteria_pie, bbox_inches='tight', pad_inches=0.3)
    plt.close()
    result['criteria_weights_pie_image'] = f'/static/{criteria_pie_filename}'

     # 4. Biểu đồ tròn tỷ lệ trọng số phương án (final score)
    final_pie_file = f'final_scores_pie_{unique_id}.png'
    path4 = os.path.join(app.root_path, 'static', final_pie_file)
    plt.figure(figsize=(8,8))
    plt.pie(alt_values, labels=alt_names, autopct='%1.1f%%', startangle=140)
    plt.title('Tỷ lệ phân phối điểm giữa các khóa học')
    plt.axis('equal')
    plt.savefig(path4, bbox_inches='tight', pad_inches=0.3)
    plt.close()
    result['final_scores_pie_image'] = f'/static/{final_pie_file}'
        

    # 7. Lưu vào MongoDB
    result_to_insert = {
    "timestamp": datetime.datetime.now(),
    **result
    }
    insert_res = collection.insert_one(result_to_insert)
    logging.info("Đã lưu với _id = %s", insert_res.inserted_id)
    result['history_id'] = str(insert_res.inserted_id)

    return jsonify(result)




@app.route('/results', methods=['GET'])
def get_results():
    """API lấy lịch sử tính toán AHP với projection fields."""
    try:
        limit      = int(request.args.get("limit", 10))
        start_date = request.args.get("start_date")
        end_date   = request.args.get("end_date")

        # Chuẩn bị query lọc theo thời gian
        query = {}
        if start_date or end_date:
            ts_query = {}
            if start_date:
                ts_query["$gte"] = datetime.datetime.strptime(start_date, "%Y-%m-%d")
            if end_date:
                # Tìm đến cuối ngày cuối (23:59:59)
                end_dt = datetime.datetime.strptime(end_date, "%Y-%m-%d")
                ts_query["$lte"] = end_dt + datetime.timedelta(days=1) - datetime.timedelta(seconds=1)
            query["timestamp"] = ts_query

        # Projection: chỉ lấy các field cần
        projection = {
            "_id": 1,
            "timestamp": 1,
            "criteria_names": 1,
            "criteria_weights": 1,
            "CR_criteria": 1,
            "alternative_names": 1,
            "final_scores": 1
        }

        # Truy vấn với projection và sort, limit
        cursor = collection.find(query, projection) \
                           .sort("timestamp", -1) \
                           .limit(limit)

        results = []
        for doc in cursor:
            # Ép kiểu ObjectId và datetime cho JSON
            history_id = str(doc["_id"])
            ts = doc.get("timestamp")
            if isinstance(ts, datetime.datetime):
                ts = ts.strftime("%Y-%m-%d %H:%M:%S")

            results.append({
                "history_id":           history_id,
                "timestamp":            ts,
                "criteria_names":       doc.get("criteria_names", []),
                "criteria_weights":     doc.get("criteria_weights", []),
                "CR_criteria":          doc.get("CR_criteria"),
                "alternative_names":    doc.get("alternative_names", []),
                "final_scores":         doc.get("final_scores", [])
            })

        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 400




# === 5. Route Export Exel / PDF ===


@app.route('/download_excel', methods=['POST'])
def download_excel():
    """Tạo và tải về file Excel chứa kết quả AHP."""
    data = request.get_json()

    # 1. Chuẩn bị DataFrame
    # Ma trận tiêu chí chuẩn hóa
    df_norm = pd.DataFrame(
        data['normalized_criteria_matrix'],
        index=data['criteria_names'],
        columns=data['criteria_names']
    )
    # Trọng số tiêu chí
    df_crit = pd.DataFrame({
        'Tiêu chí': data['criteria_names'],
        'Trọng số': data['criteria_weights']
    })
    # Ma trận phương án theo tiêu chí
    alt_blocks = []
    for crit in data['criteria_names']:
        df_alt = pd.DataFrame({
            'Phương án': data['alternative_names'], # Đổi tên cột
            f'Trọng số ({crit})': data['alternative_weights'][crit]
        })
        alt_blocks.append((crit, df_alt))
    # Kết quả tổng hợp
    df_scores = pd.DataFrame(data['final_scores']).rename(
        columns={'alternative':'Phương án','score':'Điểm tổng hợp'} # Đổi tên cột
    )

    # 2. Viết vào Excel với định dạng
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
        workbook  = writer.book
        worksheet = workbook.add_worksheet('KQ AHP')
        writer.sheets['KQ AHP'] = worksheet

        # Định nghĩa format
        header_fmt = workbook.add_format({
            'bold': True, 'bg_color': '#F7DC6F', 'border':1, 'align':'center'
        })
        cell_fmt   = workbook.add_format({'border':1})
        subhead_fmt= workbook.add_format({
            'bold': True, 'bg_color': '#AED6F1', 'border':1, 'align':'left'
        })

        row = 0
        col = 0

        # --- 2.1 Ghi Ma trận tiêu chí chuẩn hóa ---
        worksheet.write(row, col, "Ma trận tiêu chí chuẩn hóa", subhead_fmt)
        row += 1
        # Header cột
        worksheet.write(row, col, "", header_fmt)
        for j, name in enumerate(df_norm.columns):
            worksheet.write(row, col+1+j, name, header_fmt)
        # Dòng dữ liệu
        for i, idx in enumerate(df_norm.index):
            worksheet.write(row+1+i, col, idx, header_fmt)
            for j, val in enumerate(df_norm.iloc[i]):
                worksheet.write(row+1+i, col+1+j, val, cell_fmt)
        row += len(df_norm) + 2

        # --- 2.2 Ghi Trọng số tiêu chí ---
        worksheet.write(row, col, "Trọng số tiêu chí", subhead_fmt)
        row += 1
        # Header
        for j, name in enumerate(df_crit.columns):
            worksheet.write(row, col+j, name, header_fmt)
        # Dữ liệu
        for i, (_, r) in enumerate(df_crit.iterrows()):
            for j, val in enumerate(r):
                worksheet.write(row+1+i, col+j, val, cell_fmt)
        row += len(df_crit) + 2

        # --- 2.3 Ghi các ma trận phương án ---
        for crit, df_alt in alt_blocks:
            worksheet.write(row, col, f"Trọng số phương án theo tiêu chí: {crit}", subhead_fmt) # Đổi tên phần
            row += 1
            # Header
            for j, name in enumerate(df_alt.columns):
                worksheet.write(row, col+j, name, header_fmt)
            # Dữ liệu
            for i, (_, r) in enumerate(df_alt.iterrows()):
                for j, val in enumerate(r):
                    worksheet.write(row+1+i, col+j, val, cell_fmt)
            row += len(df_alt) + 2

        # --- 2.4 Ghi Kết quả tổng hợp ---
        worksheet.write(row, col, "Kết quả tổng hợp điểm số các phương án", subhead_fmt) # Đổi tên phần
        row += 1
        # Header
        for j, name in enumerate(df_scores.columns):
            worksheet.write(row, col+j, name, header_fmt)
        # Dữ liệu
        for i, (_, r) in enumerate(df_scores.iterrows()):
            for j, val in enumerate(r):
                worksheet.write(row+1+i, col+j, val, cell_fmt)

        # Auto-fit cột
        for i in range(len(df_norm.columns)+1):
            worksheet.set_column(i, i, 18)

    output.seek(0)
    return send_file(
        output,
        as_attachment=True,
        download_name='ket_qua_ahp_khoa_hoc.xlsx', # Đổi tên file
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )


    
# ===== Đăng ký font Times New Roman (Đường dẫn cần được kiểm tra trên máy chủ thực tế) =====
try:
    pdfmetrics.registerFont(TTFont('TimesNewRoman', 'C:\\Windows\\Fonts\\times.ttf'))
    registerFontFamily('TimesNewRoman', normal='TimesNewRoman')

    # Đăng ký lần 2 cho Matplotlib
    font_path = r'C:\Windows\Fonts\times.ttf'
    font_manager.fontManager.addfont(font_path)
    plt.rcParams['font.family'] = 'Times New Roman'
except Exception as e:
    logging.warning(f"Lỗi đăng ký font Times New Roman: {e}. ReportLab/Matplotlib có thể không hiển thị đúng font.")


@app.route('/report_pdf', methods=['POST'])
def report_pdf():
    """Tạo và tải về báo cáo PDF chứa bảng biểu và hình ảnh AHP."""
    data = request.get_json()
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=40, bottomMargin=40)

    styles = getSampleStyleSheet()
    styles['Normal'].fontName = 'TimesNewRoman'
    styles['Heading1'].fontName = 'TimesNewRoman'
    styles['Heading2'].fontName = 'TimesNewRoman'
    styles['Heading3'].fontName = 'TimesNewRoman'
    styles['Heading4'].fontName = 'TimesNewRoman'

    elements = []

    # ===== Tiêu đề =====
    elements.append(Paragraph("Báo cáo kết quả AHP", styles['Heading1']))

    
    # ===== Bảng ma trận tiêu chí chuẩn hóa =====
    elements.append(Paragraph("1. Ma trận tiêu chí chuẩn hóa", styles['Heading2']))
    norm_crit_df = pd.DataFrame(data['normalized_criteria_matrix'], columns=data['criteria_names'], index=data['criteria_names'])
    table_data3 = [ ["" ] + norm_crit_df.columns.tolist() ] + [ [idx] + row.tolist() for idx, row in zip(norm_crit_df.index, norm_crit_df.values) ]
    tbl3 = Table(table_data3, hAlign='LEFT')
    tbl3.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'TimesNewRoman'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
        ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
    ]))
    elements.append(tbl3)

    # ===== Bảng trọng số tiêu chí =====
    crit_df = pd.DataFrame({
        'Tiêu chí': data['criteria_names'],
        'Trọng số': data['criteria_weights']
    })
    table_data = [crit_df.columns.tolist()] + crit_df.values.tolist()
    tbl = Table(table_data, hAlign='LEFT')
    tbl.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'TimesNewRoman'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
        ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
    ]))
    elements.append(Paragraph("2. Trọng số tiêu chí", styles['Heading2']))
    elements.append(tbl)

    # ===== Bảng trọng số phương án theo từng tiêu chí =====
    for crit_name in data['criteria_names']:
        elements.append(Paragraph(f"3. Trọng số phương án theo tiêu chí: {crit_name}", styles['Heading2']))
        alt_weights = data['alternative_weights'][crit_name]
        alt_df = pd.DataFrame({
            'Phương án': data['alternative_names'], # Đổi tên cột
            'Trọng số': alt_weights
        })
        table_data_alt = [alt_df.columns.tolist()] + alt_df.values.tolist()
        tbl_alt = Table(table_data_alt, hAlign='LEFT')
        tbl_alt.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (-1, -1), 'TimesNewRoman'),
            ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
            ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
        ]))
        elements.append(tbl_alt)

    # ===== Bảng kết quả tổng hợp =====
    scores_df = pd.DataFrame(data['final_scores'])
    scores_df.columns = ['Phương án', 'Điểm tổng hợp']
    table_data2 = [scores_df.columns.tolist()] + scores_df.values.tolist()
    tbl2 = Table(table_data2, hAlign='LEFT')
    tbl2.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'TimesNewRoman'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
        ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
    ]))
    elements.append(Paragraph("4. Điểm tổng hợp các phương án", styles['Heading2']))
    elements.append(tbl2)

    # ===== Biểu đồ cột tổng hợp (matplotlib) =====
    fig, ax = plt.subplots(figsize=(4, 3))
    alts = [item['alternative'] for item in data['final_scores']]
    vals = [item['score'] for item in data['final_scores']]
    ax.bar(alts, vals, color='skyblue')
    ax.set_title("Điểm tổng hợp phương án") # Đổi tên
    ax.set_ylabel("Score")
    
    plt.xticks(rotation=45, ha='right')
    plt.tight_layout()
    
    buf_img = io.BytesIO()
    fig.savefig(buf_img, format='PNG', dpi=150, bbox_inches='tight')
    plt.close(fig)
    buf_img.seek(0)
    elements.append(Paragraph("5. Biểu đồ cột điểm tổng hợp", styles['Heading2']))
    elements.append(RLImage(buf_img, width=400, height=300))

    # ===== Biểu đồ cột trọng số tiêu chí (matplotlib) =====
    fig2, ax2 = plt.subplots(figsize=(4, 3))
    ax2.bar(data['criteria_names'], data['criteria_weights'], color='lightcoral')
    ax2.set_title("Trọng số tiêu chí")
    ax2.set_ylabel("Trọng số")
    buf_img2 = io.BytesIO()
    fig2.savefig(buf_img2, format='PNG', dpi=150, bbox_inches='tight')
    plt.close(fig2)
    buf_img2.seek(0)
    elements.append(Paragraph("6. Biểu đồ cột trọng số tiêu chí", styles['Heading2']))
    elements.append(RLImage(buf_img2, width=400, height=300))

    # Biểu đồ tròn trọng số tiêu chí (7)
    fig3, ax3 = plt.subplots(figsize=(4, 3))
    ax3.pie(data['criteria_weights'], labels=data['criteria_names'],
            autopct='%1.1f%%', startangle=140)
    ax3.set_title("Tỷ lệ trọng số tiêu chí", fontname='Times New Roman')
    ax3.axis('equal')
    buf_img3 = io.BytesIO()
    fig3.savefig(buf_img3, format='PNG', dpi=150, bbox_inches='tight')
    plt.close(fig3)
    buf_img3.seek(0)
    elements.append(Paragraph("7. Biểu đồ tròn trọng số tiêu chí", styles['Heading2']))
    elements.append(RLImage(buf_img3, width=400, height=300))

    
    # Biểu đồ tròn phân phối điểm giữa các phương án (8)
    fig4, ax4 = plt.subplots(figsize=(4, 3))
    alts = [item['alternative'] for item in data['final_scores']]
    vals = [item['score'] for item in data['final_scores']]
    ax4.pie(vals, labels=alts, autopct='%1.1f%%', startangle=140)
    ax4.set_title("Tỷ lệ phân phối điểm giữa các phương án", fontname='Times New Roman') # Đổi tên
    ax4.axis('equal')
    buf_img4 = io.BytesIO()
    fig4.savefig(buf_img4, format='PNG', dpi=150, bbox_inches='tight')
    plt.close(fig4)
    buf_img4.seek(0)
    elements.append(Paragraph("8. Biểu đồ tròn phân phối điểm giữa các phương án", styles['Heading2']))
    elements.append(RLImage(buf_img4, width=400, height=300))
    
    # ===== Kết thúc và trả file PDF =====
    doc.build(elements)
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype='application/pdf',
        as_attachment=True,
        download_name='report_ahp_khoa_hoc.pdf'
    )
    
# lấy dữ liệu khóa học lên
@app.route('/db/courses', methods=['GET'])
def list_courses():
    """API lấy danh sách khóa học từ MongoDB."""
    page      = int(request.args.get('page', 1))
    per_page  = int(request.args.get('per_page', 10))
    language_filter     = request.args.get('language', None) 
    search_keyword = request.args.get('search', None)


    # Chuẩn bị query và projection
    query      = {}
    if language_filter:
        query["ngon_ngu"] = language_filter
    if search_keyword:
        query["ten_khoa"] = {"$regex": search_keyword, "$options": "i"} # Tìm kiếm không phân biệt chữ hoa/thường

    projection = { 
        "_id": 0,
        "ten_khoa": 1,
        "nen_tang": 1, 
        "gia": 1,
        "thoi_luong": 1, 
        "danh_gia": 1,
        "chung_chi": 1,
        "ngon_ngu": 1,
        "image_url": 1}

    # Chạy find với pagination
    cursor = courses_coll.find(query, projection) \
                             .skip((page-1) * per_page) \
                             .limit(per_page)

    courses = list(cursor)
    return jsonify(courses)

# Lấy tiêu chí
@app.route('/db/criteria', methods=['GET'])
def list_criteria():
    criteria = [
        "gia",
        "thoi_luong",
        "danh_gia",
        "chung_chi",
        "ngon_ngu",
        "uy_tin_giang_vien",
        "do_kho",
        "dich_vu_ho_tro",
        "kha_nang_ung_dung"
    ]
    return jsonify(criteria)


# Lấy tên các ngôn ngữ làm bộ lọc
@app.route('/db/languages', methods=['GET'])
def list_languages():
    """API lấy danh sách các ngôn ngữ có sẵn (dùng làm bộ lọc)."""
    languages = courses_coll.distinct('ngon_ngu')
    return jsonify(sorted(languages))


if __name__ == "__main__":
    app.run(debug=True)