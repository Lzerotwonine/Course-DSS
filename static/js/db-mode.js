// db-mode.js
// Chuyển đổi từ chế độ chọn DB sang chế độ AHP tự động

// Biến toàn cục để theo dõi trạng thái CR của các ma trận phương án
let altCRValid = [];

// 1. Hàm điền tên phương án và tiêu chí từ DB
function populateNamesFromDB(altsArray, critsArray) {
  const container = document.getElementById("namesContainer");
  container.innerHTML = '<h3>Tên phương án và tiêu chí:</h3>';

  // Phương án
  container.innerHTML += '<h4>Phương án:</h4>' +
    altsArray.map((name, i) =>
      `<input type="text" id="alternative_${i}" value="${name}" readonly />`
    ).join('');

  // Tiêu chí
  container.innerHTML += '<h4>Tiêu chí:</h4>' +
    critsArray.map((name, i) =>
      `<input type="text" id="criteria_${i}" value="${name}" readonly />`
    ).join('');
}

// 2. Vẽ ma trận tiêu chí tự động cho DB mode
function db_generateEvaluationMatrix() {
  // 1. Lấy danh sách tên tiêu chí
  const critInputs = document.querySelectorAll("input[id^='criteria_']");
  const n = critInputs.length;
  const labels = Array.from(critInputs).map(i => i.value.trim() || `Tiêu chí ${i.id.split('_')[1]}`);

  // 2. Xóa vùng cũ, rebuild header
  const container = document.getElementById("criteriaMatrixContainer");
  container.innerHTML = `<h3>Ma trận so sánh tiêu chí</h3>`;

  const table = document.createElement('table');
  table.classList.add('matrix-table');

  // 3. Header
  const hdr = document.createElement('tr');
  hdr.appendChild(document.createElement('th')); // góc trống
  labels.forEach(l => {
    const th = document.createElement('th');
    th.innerText = l;
    hdr.appendChild(th);
  });
  table.appendChild(hdr);

  // 4. Các hàng
  for (let i = 0; i < n; i++) {
    const row = document.createElement('tr');
    // tiêu đề hàng
    const th = document.createElement('th');
    th.innerText = labels[i];
    row.appendChild(th);

    for (let j = 0; j < n; j++) {
      const cell = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.id = `criteria_${i}_${j}`;
      inp.min = '0.111';      // tương đương 1/9
      inp.max = '9';
      inp.step = '0.1';
      inp.value = (i === j ? '1' : '1');
      if (i === j) inp.disabled = true;
      inp.dataset.row = i;
      inp.dataset.col = j;

      // 5. Bắt lỗi input ngoài khoảng
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (isNaN(v) || v <= 0) {
          alert('Giá trị phải > 0');
          inp.value = '1';
        } else if (v < 1 / 9) {
          alert('AHP chỉ cho phép giá trị từ 1/9 đến 9');
          inp.value = (1 / 9).toFixed(3);
        } else if (v > 9) {
          alert('AHP chỉ cho phép giá trị từ 1/9 đến 9');
          inp.value = '9';
        }
      });

      // 6. Khi blur thì đồng bộ phần tử đối xứng và tự động check CR
      inp.addEventListener("blur", () => {
        updateSymmetricValue(inp);
        checkCriteriaCRAuto();
      });

      cell.appendChild(inp);
      row.appendChild(cell);
    }
    table.appendChild(row);
  }

  container.appendChild(table);

  // 7. Hiện nút kiểm tra CR tiêu chí, ẩn alt-CR & nút tính toán
  document.getElementById("crCheckBtnContainer").style.display = 'block';
  document.getElementById("altCRCheckBtnContainer").style.display = 'none';
  document.getElementById("calcBtn").style.display = 'none';

  // 8. Sinh luôn ma trận Phương án
  db_generateAlternativeMatrices();
}

// Hàm để tự động tính toán CR tiêu chí khi ma trận thay đổi
function checkCriteriaCRAuto() {
  // 1. Đếm đúng số tiêu chí
  const critNameInputs = document.querySelectorAll(
    "#namesContainer input[id^='criteria_'][readonly]"
  );
  const n = critNameInputs.length;

  // 2. Xây ma trận kích thước n×n
  const matrix = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const el = document.getElementById(`criteria_${i}_${j}`);
      // nếu el = null nghĩa là id không có, tránh crash
      const v = el ? parseFloat(el.value) : 1;
      row.push(isNaN(v) || v <= 0 ? 1 : v);
    }
    matrix.push(row);
  }

  // 3. Gửi lên server
  fetch("/check_criteria_cr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria_matrix: matrix })
  })
    .then(r => r.json())
    .then(res => {
      const dst = document.getElementById("crCheckResult");
      dst.innerHTML = `
        <h4>Chỉ số nhất quán (Tiêu chí):</h4>
        <p>λₘₐₓ: <strong>${res.lambda_max.toFixed(4)}</strong></p>
        <p>CI: <strong>${res.CI.toFixed(4)}</strong></p>
        <p>CR: <strong>${res.CR.toFixed(4)}</strong>
          ${res.valid
          ? '<span style="color:green;">(Hợp lệ)</span>'
          : '<span style="color:red;">(Quá cao!)</span>'}
        </p>
      `;
      // Hiển thị/ẩn nút alt-CR & tính toán
      document.getElementById("altCRCheckBtnContainer").style.display = res.valid ? 'block' : 'none';
      // Nút tính toán AHP chỉ hiện khi CR tiêu chí OK VÀ CR phương án OK (sẽ được cập nhật ở checkAltCRForCriterion)
      // Tạm ẩn ở đây, sẽ được cập nhật lại khi check CR Phương án
      // document.getElementById("calcBtn").style.display               = res.valid ? 'block' : 'none'; 
      document.getElementById("calcBtn").style.display = 'none';
    })
    .catch(err => console.error("Error checking criteria CR:", err));
}


// 3. Gửi AJAX kiểm tra CR cho ma trận phương án thứ k
function checkAltCRForCriterion(k) {
  // Lấy kích thước ma trận (m)
  const m = document.querySelectorAll(`input[id^="alt_${k}_0_"]`).length;
  // Xây dựng ma trận
  const matrix = [];
  for (let i = 0; i < m; i++) {
    const row = [];
    for (let j = 0; j < m; j++) {
      const v = parseFloat(document.getElementById(`alt_${k}_${i}_${j}`).value);
      row.push(isNaN(v) || v <= 0 ? 1 : v);
    }
    matrix.push(row);
  }

  // Gửi lên server
  fetch("/check_criteria_cr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria_matrix: matrix })
  })
    .then(r => r.json())
    .then(res => {
      // Hiện kết quả ngay trong block tương ứng
      const block = document.querySelector(`.alt-matrix-block[data-index="${k}"]`);
      const crDiv = block.querySelector(".alt-cr-result");
      crDiv.innerHTML = `
        <p>λₘₐₓ: <strong>${res.lambda_max.toFixed(4)}</strong></p>
        <p>CI: <strong>${res.CI.toFixed(4)}</strong></p>
        <p>CR: <strong>${res.CR.toFixed(4)}</strong>
           ${res.valid
          ? '<span style="color:green;">(Hợp lệ)</span>'
          : '<span style="color:red;">(Quá cao!)</span>'}
        </p>
      `;

      // Cập nhật trạng thái
      altCRValid[k] = res.valid;

      // Nếu tất cả đều hợp lệ VÀ CR Tiêu chí cũng hợp lệ, hiện nút Tính toán
      const isCriteriaValid = document.getElementById("crCheckBtnContainer").style.display !== 'none';
      const allAltsOk = altCRValid.every(flag => flag === true);
      document.getElementById("calcBtn").style.display = (allAltsOk && isCriteriaValid) ? "inline-block" : "none";
    })
    .catch(err => {
      console.error("Lỗi kiểm tra CR phương án cho tiêu chí", k, err);
    });
}

// Bản đầy đủ của db_generateAlternativeMatrices:
function db_generateAlternativeMatrices() {
  const altInputs = document.querySelectorAll("input[id^='alternative_']");
  const critInputs = document.querySelectorAll("#namesContainer input[id^='criteria_']");
  const alts = Array.from(altInputs).map(i => i.value);
  const crits = Array.from(critInputs).map(i => i.value);
  const m = alts.length, n = crits.length;

  // Khởi tạo lại mảng trạng thái
  altCRValid = new Array(n).fill(false);

  const container = document.getElementById("alternativeMatricesContainer");
  container.innerHTML = "";

  for (let k = 0; k < n; k++) {
    // Tạo block riêng cho tiêu chí k
    const block = document.createElement("div");
    block.className = "alt-matrix-block";
    block.dataset.index = k;

    // Tiêu đề
    const title = document.createElement("h4");
    title.textContent = `ma trận phương án – Tiêu chí: ${crits[k]}`; // Đổi tên phần
    block.appendChild(title);

    // Bảng ma trận
    const table = document.createElement("table");
    table.classList.add("matrix-table");
    // Header cột
    const hdr = document.createElement("tr");
    hdr.appendChild(document.createElement("th"));
    alts.forEach(a => {
      const th = document.createElement("th");
      th.innerText = a;
      hdr.appendChild(th);
    });
    table.appendChild(hdr);

    // Các hàng dữ liệu
    for (let i = 0; i < m; i++) {
      const row = document.createElement("tr");
      const th = document.createElement("th");
      th.innerText = alts[i];
      row.appendChild(th);

      for (let j = 0; j < m; j++) {
        const cell = document.createElement("td");
        const inp = document.createElement("input");
        inp.type = "number";
        inp.id = `alt_${k}_${i}_${j}`;
        inp.min = (1 / 9).toFixed(3);
        inp.max = "9";
        inp.step = "0.001";
        inp.value = "1";
        if (i === j) inp.disabled = true;

        // Khi blur, validate, đồng bộ đối xứng và check CR
        inp.addEventListener("blur", () => {
          let v = parseFloat(inp.value);
          if (isNaN(v) || v < 1 / 9 || v > 9) {
            alert("Giá trị phải trong khoảng 1/9 đến 9!");
            v = 1;
            inp.value = "1";
          }
          // Đồng bộ ô đối xứng
          const sym = document.getElementById(`alt_${k}_${j}_${i}`);
          if (sym) sym.value = (1 / v).toFixed(3);
          // Tự động check CR cho tiêu chí k
          checkAltCRForCriterion(k);
        });

        cell.appendChild(inp);
        row.appendChild(cell);
      }
      table.appendChild(row);
    }

    // Vùng hiển thị kết quả CR cho matrix k
    const crDiv = document.createElement("div");
    crDiv.className = "alt-cr-result";

    block.appendChild(table);
    block.appendChild(crDiv);
    container.appendChild(block);
  }

  // Ẩn nút kiểm tra CR thủ công
  document.getElementById("altCRCheckBtnContainer").style.display = "block";
}


// 4. DOMContentLoaded: xử lý toàn bộ flow DB→AHP
document.addEventListener('DOMContentLoaded', () => {
  const courseSearch = $('#courseSearch'); // Đổi tên ID
  const critSearch = $('#critSearch');
  const coursesGrid = $('#coursesGrid'); // Đổi tên ID
  const criteriaGrid = $('#criteriaGrid');
  const selectedCourses = $('#selectedCourses'); // Đổi tên ID
  const selectedCriteria = $('#selectedCriteria');
  const startBtn = $('#startDB');

  let allCourses = [], allCrits = []; // Đổi tên biến
  const chosenCourses = new Set(), chosenCrits = new Set(); // Đổi tên biến
  let coursesFiltered = []; // Đổi tên biến
  let currentPage = 1;
  const itemsPerPage = 20;  // hiển thị 20 phương án / trang

  // Hàm phụ phân trang
  function paginateAndRender(courseArray) { // Đổi tên hàm/biến
    // tính start/end
    const start = (currentPage - 1) * itemsPerPage;
    const pageItems = courseArray.slice(start, start + itemsPerPage);
    // vẽ
    renderCourseCards(pageItems, coursesGrid); // Đổi tên hàm

    // cập nhật UI phân trang
    const totalPages = Math.max(1, Math.ceil(courseArray.length / itemsPerPage));
    $('#pageInfo').text(`Trang ${currentPage} / ${totalPages}`);
    $('#prevPage').prop('disabled', currentPage === 1);
    $('#nextPage').prop('disabled', currentPage === totalPages);
  }
  $('#prevPage').click(() => {
    if (currentPage > 1) {
      currentPage--;
      paginateAndRender(coursesFiltered);
    }
  });
  $('#nextPage').click(() => {
    const totalPages = Math.ceil(coursesFiltered.length / itemsPerPage);
    if (currentPage < totalPages) {
      currentPage++;
      paginateAndRender(coursesFiltered);
    }
  });


  // Fetch từ backend
  Promise.all([
    fetch('/db/courses?per_page=55').then(r => r.json()), // Đổi route
    fetch('/db/criteria').then(r => r.json())
  ]).then(([courses, crits]) => { // Đổi tên biến
    allCourses = courses.map(b => ({ // Đổi tên biến/logic
      ...b,
      id: `${b.ten_khoa}-${b.nen_tang}`,
      label: `${b.ten_khoa}`
    }));
    allCrits = crits.map(c => ({ id: c, label: c }));
    coursesFiltered = allCourses.slice(); // Đổi tên biến
    paginateAndRender(coursesFiltered);
    renderCriteriaCards(allCrits, criteriaGrid);
    // Gán event
    $('#coursesGrid').on('click', '.course-card', function () { // Đổi class
      const info = $(this).data('info');
      selectCourse({ // Đổi tên hàm
        id: `${info.ten_khoa}-${info.nen_tang}`,
        label: `${info.ten_khoa}`
      });
    });

    // 2. Click chọn tiêu chí
    $('#criteriaGrid').on('click', '.crit-card', function () {
      const critId = $(this).data('crit');
      selectCrit({ id: critId, label: critId });
    });

  });

  // Load danh sách ngôn ngữ và gán vào dropdown
  fetch('/db/languages') // Đổi route
    .then(r => r.json())
    .then(languages => { // Đổi tên biến
      const languageFilter = $('#languageFilter'); // Đổi tên ID
      languageFilter.append(`<option value="">-- Tất cả --</option>`);
      languages.forEach(language => { // Đổi tên biến
        languageFilter.append(`<option value="${language}">${language}</option>`);
      });
    });

  // Khi thay đổi ngôn ngữ, gọi lại courses theo language
  $('#languageFilter').on('change', function () { // Đổi tên ID
    const selectedLanguage = $(this).val(); // Đổi tên biến
    // Cần gọi lại API /db/courses với filter
    updateCourseGrid(); // Dùng hàm update chung
  });


  // render chung phương án
  function renderCourseCards(courses, $container) { // Đổi tên hàm/biến
    $container.empty();
    courses.forEach(b => {
      const info = {
        ten_khoa: b.ten_khoa,
        nen_tang: b.nen_tang,
        gia: b.gia,
        thoi_luong: b.thoi_luong,
        danh_gia: b.danh_gia,
        chung_chi: b.chung_chi,
        ngon_ngu: b.ngon_ngu,
        image_url: b.image_url
      };
      // Đổi class, id, nội dung HTML
      const $card = $(`
        <div class="card course-card" data-info='${JSON.stringify(info)}'>
          <img src="${b.image_url}" 
               alt="${b.ten_khoa}" 
               class="course-img">
          <div class="course-title">
            ${b.nen_tang} – ${b.ten_khoa}
          </div>
        </div>
      `);
      $container.append($card);
    });
  }
  const critLabelMap = {
    gia: "Mức phí",
    thoi_luong: "Thời lượng",
    danh_gia: "Đánh giá",
    chung_chi: "Chất lượng chứng chỉ",
    ngon_ngu: "Ngôn ngữ",
    uy_tin_giang_vien: "Uy tín giảng viên",
    do_kho: "Độ khó",
    dich_vu_ho_tro: "Dịch vụ hỗ trợ",
    kha_nang_ung_dung: "Khả năng ứng dụng"
  };

  function renderCriteriaCards(crits, $container) {
    $container.empty();
    crits.forEach(c => {
      const vietLabel = critLabelMap[c.id] || c.label;

      const $card = $(`
        <div class="card crit-card"
            data-crit="${c.id}"
            title="${vietLabel}">
          ${vietLabel} <!-- Sử dụng nhãn tiếng Việt để hiển thị -->
        </div>
      `);
      $container.append($card);
    });
  }


  // hàm chọn phương án
  function selectCourse(item) {
    if (!chosenCourses.has(item.id)) {
      chosenCourses.add(item.id);
      selectedCourses.append(`
        <span class="selected-item" data-id="${item.id}">
          ${item.label}
          <span class="remove-btn">×</span>
        </span>
      `);
      attachRemoveEvents(selectedCourses, chosenCourses, coursesGrid, allCourses, courseSearch, selectCourse);
      updateCourseGrid();
    }
  }

  // hàm chọn tiêu chí
  function selectCrit(item) {
    if (!chosenCrits.has(item.id)) {
      chosenCrits.add(item.id);
      selectedCriteria.append(`
        <span class="selected-item" data-id="${item.id}">
          ${item.label}
          <span class="remove-btn">×</span>
        </span>
      `);
      attachRemoveEvents(selectedCriteria, chosenCrits, criteriaGrid, allCrits, critSearch, selectCrit);
      renderCriteriaCards(filteredCrits(allCrits, critSearch.val()), criteriaGrid); // Dùng hàm riêng cho crit
    }
  }
  
  // Hàm dùng chung - thêm dấu x để loại bỏ
  function attachRemoveEvents(container, chosenSet, grid, allItems, searchInput, selectFn) {
    container.find('.remove-btn').off('click').on('click', function () {
      const itemId = $(this).parent().data('id');
      chosenSet.delete(itemId);
      $(this).parent().remove();
      if (grid.is(coursesGrid)) {
        updateCourseGrid();
      } else {
        renderCriteriaCards(filteredCrits(allCrits, critSearch.val()), criteriaGrid);
      }
    });
  }

  // Hàm lọc tiêu chí
  function filteredCrits(arr, term) {
    term = term.trim().toLowerCase();
    return arr.filter(c => {
      const vietLabel = critLabelMap[c.id] || c.label;
      return vietLabel.toLowerCase().includes(term);
    });
  }


  const priceMinInput = $('#priceMin');
  const priceMaxInput = $('#priceMax');
  // chuyển đổi có dấu , cho dễ nhìn
  function formatNumberWithCommas(str) {
    // Chuyển "1234567" → "1,234,567"
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function setupThousandSeparator(id) {
    const inp = document.getElementById(id);
    inp.dataset.raw = ''; // lưu giá trị số thô

    inp.addEventListener('input', e => {
      const { selectionStart } = inp;
      // Giữ chỉ chữ số
      const raw = inp.value.replace(/\D+/g, '');
      inp.dataset.raw = raw;
      // Format với dấu phẩy
      const formatted = raw ? formatNumberWithCommas(raw) : '';
      inp.value = formatted;
      // Giữ con trỏ gần đúng chỗ cũ
      const diff = formatted.length - raw.length;
      inp.setSelectionRange(selectionStart + diff, selectionStart + diff);
    });

    inp.addEventListener('blur', () => {
      if (!inp.dataset.raw) inp.value = '';
    });
  }

  // Áp dụng
  ['priceMin', 'priceMax'].forEach(setupThousandSeparator);


  // Khi bấm nút chuyển sang AHP
  $('#startDB').off('click').on('click', function () {
    if (chosenCourses.size < 2 || chosenCrits.size < 2) { // Đổi tên Set
      alert('Phải chọn tối thiểu 2 phương án và 2 tiêu chí.');
      return;
    }

    // Lấy tên phương án (alternative) từ Set (chứa tên_khoa-nền_tảng)
    const altsArray = Array.from(chosenCourses).map(id => {
      const parts = id.split('-');
      return parts.length > 1 ? parts[0] : id; // Chỉ lấy tên phương án (phần tử đầu)
    });
    const critsArray = Array.from(chosenCrits);

    $('#dbPanel').hide();
    $('#ahpPanel').show();

    // Xoá các ma trận cũ nếu có
    $('#criteriaMatrixContainer').empty();
    $('#alternativeMatricesContainer').empty();

    // Điền tên và tạo lại ma trận
    populateNamesFromDB(altsArray, critsArray);
    db_generateEvaluationMatrix();        // tạo ma trận tiêu chí
    // db_generateAlternativeMatrices();     // đã được gọi trong db_generateEvaluationMatrix

    $('#crCheckBtnContainer, #altCRCheckBtnContainer, #calcBtn').show();
  });

  // update lưới phương án theo bộ lọc
  function updateCourseGrid() { // Đổi tên hàm
    const term = courseSearch.val().toLowerCase(); // Đổi tên ID
    const minRaw = document.getElementById('priceMin').dataset.raw;
    const maxRaw = document.getElementById('priceMax').dataset.raw;
    const minP = minRaw ? parseInt(minRaw, 10) : 0;
    const maxP = maxRaw ? parseInt(maxRaw, 10) : Infinity;
    const language = $('#languageFilter').val(); // Đổi tên ID

    // Lọc theo tất cả tiêu chí
    const filtered = allCourses.filter(b =>
      (b.ten_khoa.toLowerCase().includes(term) || // Đổi tên field
        b.nen_tang.toLowerCase().includes(term) || // Đổi tên field
        (b.mo_ta_ngan && b.mo_ta_ngan.toLowerCase().includes(term))) && // Thêm tìm kiếm theo mô tả
      b.gia >= minP &&
      (maxP === Infinity || b.gia <= maxP) &&
      (!language || b.ngon_ngu === language) // Lọc theo ngôn ngữ
    );

    // Gán kết quả vào coursesFiltered
    coursesFiltered = filtered; // Đổi tên biến
    currentPage = 1;
    paginateAndRender(coursesFiltered);
  }

  // Gắn event cho các bộ lọc phương án
  courseSearch.on('input', updateCourseGrid);
  priceMinInput.on('input', updateCourseGrid);
  priceMaxInput.on('input', updateCourseGrid);
  $('#languageFilter').on('change', updateCourseGrid); // Đổi tên ID

  // Gắn event cho tìm kiếm tiêu chí
  critSearch.on('input', () => {
    renderCriteriaCards(filteredCrits(allCrits, critSearch.val()), criteriaGrid);
  });

  // Hủy event cho các nút kiểm tra CR thủ công (vì ta dùng auto)
  // document.getElementById("crCheckBtnContainer").style.display = 'block'; // Đã ở trên
  // document.getElementById("altCRCheckBtnContainer").style.display = 'block'; // Đã ở trên

});


//Kiểm tra CR Tiêu chí (hàm thủ công)
function db_checkCriteriaCR() {
  const critInputs = document.querySelectorAll('#namesContainer input[id^="criteria_"]');
  const n = critInputs.length;
  if (n < 2) {
    alert('Phải có ít nhất 2 tiêu chí.');
    return;
  }

  const matrix = [];

  try {
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < n; j++) {
        // Lấy giá trị trực tiếp từ ô nhập
        let value;
        const el = document.getElementById(`criteria_${i}_${j}`);
        if (!el) throw new Error(`Thiếu dữ liệu tại ô [${i + 1}, ${j + 1}]!`);

        value = parseFloat(el.value);

        if (isNaN(value) || value <= 0) {
          throw new Error(`Dữ liệu không hợp lệ tại ô [${i + 1}, ${j + 1}].`);
        }
        row.push(value);
      }
      matrix.push(row);
    }
  } catch (err) {
    alert(err.message);
    return;
  }

  // Gửi matrix lên server kiểm tra CR
  $.ajax({
    url: "/check_criteria_cr",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({ criteria_matrix: matrix }),
    success: function (res) {
      let html = `
        <h4>Chỉ số nhất quán:</h4>
        <p>λₘₐₓ: <strong>${res.lambda_max.toFixed(4)}</strong></p>
        <p>CI: <strong>${res.CI.toFixed(4)}</strong></p>
        <p>CR: <strong>${res.CR.toFixed(4)}</strong></p>
      `;

      // Nếu CR tiêu chí hợp lệ:
      if (res.valid) {
        // Nếu CR phương án cũng OK, nút tính toán sẽ được hiện trong db_checkAlternativeCR
        // Tạm thời chỉ hiện nút kiểm tra CR phương án
        document.getElementById("altCRCheckBtnContainer").style.display = "block";
        document.getElementById("calcBtn").style.display = "none";
        html += `<p style="color:green;">CR hợp lệ. Tiếp tục nhập ma trận phương án.</p>`;
      } else {
        document.getElementById("altCRCheckBtnContainer").style.display = "none";
        document.getElementById("calcBtn").style.display = "none";
        html += `<p style="color:red;">CR quá cao (>0.1). Vui lòng điều chỉnh!</p>`;
      }

      document.getElementById("crCheckResult").innerHTML = html;
    },
    error: function (err) {
      // ẩn cả hai nút luôn
      document.getElementById("altCRCheckBtnContainer").style.display = "none";
      document.getElementById("calcBtn").style.display = "none";
      document.getElementById("crCheckResult").innerHTML =
        `<p style="color:red;">Lỗi server: ${err.responseJSON?.error || err.statusText}</p>`;
    }
  });
}


//Kiểm tra CR phương án (hàm thủ công)
function db_checkAlternativeCR() {
  const critInputs = document.querySelectorAll('#namesContainer input[id^="criteria_"]');
  const nCrit = critInputs.length;
  let allValid = true;
  const calls = [];

  // xoá kết quả cũ mỗi block
  document.querySelectorAll('.alt-matrix-block .alt-cr-result')
    .forEach(div => div.innerHTML = '');

  for (let k = 0; k < nCrit; k++) {
    // build ma trận như trên
    const matrix = [];
    const m = document.querySelectorAll(`input[id^="alt_${k}_"]`).length ** 0.5;
    for (let i = 0; i < m; i++) {
      const row = [];
      for (let j = 0; j < m; j++) {
        const el = document.getElementById(`alt_${k}_${i}_${j}`);
        const val = parseFloat(el.value) || 1;
        row.push(val);
      }
      matrix.push(row);
    }

    calls.push(
      $.ajax({
        url: "/check_criteria_cr",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({ criteria_matrix: matrix })
      })
        .done(res => {
          allValid = allValid && res.valid;
          const block = document.querySelector(`.alt-matrix-block[data-index="${k}"]`);
          const crDiv = block.querySelector('.alt-cr-result');
          crDiv.innerHTML = `
          <h5>Tiêu chí "${critInputs[k].value}"</h5>
          <p>λₘₐₓ: ${res.lambda_max.toFixed(4)}</p>
          <p>CI: ${res.CI.toFixed(4)}</p>
          <p>CR: ${res.CR.toFixed(4)}
             ${res.valid ? '<span style="color:green;">(Hợp lệ)</span>'
            : '<span style="color:red;">(Quá cao!)</span>'}
          </p>
        `;
        })
        .fail(() => {
          const block = document.querySelector(`.alt-matrix-block[data-index="${k}"]`);
          block.querySelector('.alt-cr-result').innerHTML =
            `<p style="color:red;">Lỗi khi kiểm tra nhất quán</p>`;
          allValid = false;
        })
    );
  }

  // Cập nhật nút Tính toán sau khi tất cả các cuộc gọi hoàn thành
  Promise.all(calls).then(() => {
    // Kiểm tra thêm CR tiêu chí có hợp lệ không trước khi hiện nút
    const criteriaCR = document.getElementById("crCheckResult").innerHTML;
    const isCriteriaValid = criteriaCR.includes('(Hợp lệ)') || criteriaCR.includes('CR hợp lệ');

    document.getElementById("calcBtn").style.display = (allValid && isCriteriaValid) ? "block" : "none";

    // Hiển thị kết quả CR tổng hợp
    const overallResultDiv = document.getElementById("altCrCheckResult");
    overallResultDiv.innerHTML = `
      <h4 style="margin-top: 1rem;">Kết quả kiểm tra nhất quán phương án: 
        ${allValid ? '<span style="color:green;">Tất cả đều HỢP LỆ</span>' : '<span style="color:red;">CÓ LỖI (Vui lòng điều chỉnh)</span>'}
      </h4>
    `;
    // Thêm kết quả chi tiết
    document.querySelectorAll('.alt-matrix-block').forEach(block => {
      overallResultDiv.appendChild(block.cloneNode(true));
    });

  });
}


// === Hàm tính AHP cho DB Mode (thay cho calculateAHP cũ) ===
function db_calculateAHP() {
  // 1. Lấy tên tiêu chí
  const critInputs = Array.from(
    document.querySelectorAll("#namesContainer input[id^='criteria_']")
  ).filter(el => el.readOnly || el.hasAttribute("readonly"));
  const criteriaNames = critInputs.map(el => el.value.trim());
  const numCriteria = criteriaNames.length;

  // 2. Lấy tên phương án
  const altInputs = Array.from(
    document.querySelectorAll("#namesContainer input[id^='alternative_']")
  ).filter(el => el.readOnly || el.hasAttribute("readonly"));
  const alternativeNames = altInputs.map(el => el.value.trim());
  const numAlternatives = alternativeNames.length;

  // 3. Xây dựng ma trận tiêu chí (giống hệt checkCriteriaCR)
  const criteriaMatrix = [];
  for (let i = 0; i < numCriteria; i++) {
    const row = [];
    for (let j = 0; j < numCriteria; j++) {
      const el = document.getElementById(`criteria_${i}_${j}`);
      const v = parseFloat(el.value);
      if (isNaN(v) || v <= 0) {
        alert(`Giá trị ma trận tiêu chí không hợp lệ tại [${i + 1},${j + 1}].`);
        return;
      }
      row.push(v);
    }
    criteriaMatrix.push(row);
  }

  // 4. Xây dựng các ma trận phương án theo từng tiêu chí (giống hệt checkAlternativeCR)
  const alternativeMatrices = {};
  for (let k = 0; k < numCriteria; k++) {
    const matrix = [];
    for (let i = 0; i < numAlternatives; i++) {
      const row = [];
      for (let j = 0; j < numAlternatives; j++) {
        const el = document.getElementById(`alt_${k}_${i}_${j}`);
        const v = parseFloat(el.value);
        if (isNaN(v) || v <= 0) {
          alert(`Giá trị ma trận phương án không hợp lệ tại tiêu chí "${criteriaNames[k]}", ô [${i + 1},${j + 1}].`);
          return;
        }
        row.push(v);
      }
      matrix.push(row);
    }
    alternativeMatrices[criteriaNames[k]] = matrix;
  }

  // 5. Gửi AJAX lên server và xử lý kết quả
  $.ajax({
    url: "/ahp",
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify({
      criteria_matrix: criteriaMatrix,
      alternative_matrices: alternativeMatrices,
      alternative_names: alternativeNames,
      criteria_names: criteriaNames
    }),
    success: function (response) {
      window.lastResult = response;
      // Dùng hàm render từ script.js để hiển thị kết quả
      const resultHTML = buildResultHTML(response, true); // true để biết là DB Mode
      document.getElementById("result").innerHTML = resultHTML;

      // Hiển thị nút xuất file
      document.getElementById("exportExcelBtn").style.display = "inline-block";
      document.getElementById("btnPDF").style.display = "inline-block";
    },
    error: function (err) {
      document.getElementById("result").innerHTML =
        `<p style="color:red;">Lỗi server: ${err.responseJSON?.error || err.statusText}</p>`;
    }
  });
}

// Lịch sử truy vấn AHP – database
function loadHistory_db() {
  const listEl = document.getElementById('historyList');
  const userLimit = parseInt(document.getElementById('historyLimit').value, 10) || 10;
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;

  // Kiểm tra logic ngày
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    alert('❌ "Từ ngày" không được lớn hơn "Đến ngày"! - Ngày mở đầu phải trước ngày kết thúc');
    return;
  }

  fetch(`/results?limit=1000`)
    .then(res => res.json())
    .then(list => {
      const s = startDate ? new Date(startDate + 'T00:00:00') : null;
      const e = endDate ? new Date(endDate + 'T23:59:59') : null;

      list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      let filtered = list.filter(item => {
        const t = new Date(item.timestamp);
        if (s && t < s) return false;
        if (e && t > e) return false;
        return true;
      });

      filtered = filtered.slice(0, userLimit);

      listEl.innerHTML = '';
      if (!filtered.length) {
        listEl.textContent = 'Không có bản ghi nào phù hợp.';
        return;
      }

      const tmpl = document.getElementById('history-item-template');
      filtered.forEach(data => {
        const clone = tmpl.content.cloneNode(true);
        const item = clone.querySelector('.history-item');
        clone.querySelector('.timestamp').textContent = new Date(data.timestamp).toLocaleString('vi-VN');
        clone.querySelector('.top1').textContent = data.final_scores[0].alternative; // Tên phương án

        const detail = clone.querySelector('.dropdown-content');
        detail.innerHTML = `
          <p><strong>Ngày:</strong> ${new Date(data.timestamp).toLocaleDateString('vi-VN')}</p>
          <p><strong>CR Tiêu chí:</strong> ${data.CR_criteria.toFixed(4)}</p>
          <p><strong>Tiêu chí:</strong> ${data.criteria_names.join(', ')}</p>
          <p><strong>Trọng số:</strong> ${data.criteria_weights.map(w => w.toFixed(3)).join(', ')}</p>
          <p><strong>Top 3 phương án:</strong> ${ // Đổi tên phần
          data.final_scores.slice(0, 3)
            .map(o => `${o.alternative} (${o.score.toFixed(3)})`)
            .join('; ')
          }</p>
        `;
        clone.querySelector('.dropdown-toggle')
          .addEventListener('click', (e) => {
            e.currentTarget.parentElement.classList.toggle('open');
          });

        listEl.appendChild(clone);
      });
    })
    .catch(err => {
      console.error(err);
      alert('Lỗi khi tải lịch sử.');
    });
}

// ✅ Gọi khi bấm nút
document.getElementById('btnLoadHistory').addEventListener('click', loadHistory_db);

// ✅ Gọi khi thay đổi input
['startDate', 'endDate', 'historyLimit'].forEach(id => {
  document.getElementById(id).addEventListener('change', loadHistory_db);
});

//Hiển thị Tooltip khi hover (Đã đổi tên và nội dung)
document.addEventListener('DOMContentLoaded', () => {
  let hoverTimer;
  const courseTooltip = $('#course-tooltip'); // Đổi tên ID

  // 1. Delegated hover handlers trên #coursesGrid
  $('#coursesGrid') // Đổi tên ID
    .on('mouseenter', '.course-card', function (e) { // Đổi class
      const $card = $(this);
      // Thiết lập timer 1s
      hoverTimer = setTimeout(() => {
        const info = $card.data('info');
        // === Tạo tpl ở đây ===
        const tpl = `
          <strong>${info.nen_tang} – ${info.ten_khoa}</strong><br>
          <img src="${info.image_url}"
               style="width:100%;margin:8px 0;border-radius:4px;"><br>
          <div style="text-align:left;font-size:0.85rem;line-height:1.2">
            <div>🏢 Nền tảng: ${info.nen_tang}</div>
            <div>💰 Phí: ${info.gia.toLocaleString()} VND</div>
            <div>⏱️ Thời lượng: ${info.thoi_luong} giờ</div>
            <div>⭐ Đánh giá: ${info.danh_gia} sao</div>
            <div>📜 Chứng chỉ: ${info.chung_chi ? 'Có' : 'Không'}</div>
            <div>🌐 Ngôn ngữ: ${info.ngon_ngu}</div>
          </div>
        `;
        courseTooltip // Đổi tên biến
          .html(tpl)
          .css({ top: e.pageY + 12, left: e.pageX + 12 })
          .fadeIn(150);
      }, 1000);
    })
    .on('mouseleave', '.course-card', function () { // Đổi class
      clearTimeout(hoverTimer);
      courseTooltip.stop(true).fadeOut(100); // Đổi tên biến
    })
    .on('mousemove', '.course-card', function (e) { // Đổi class
      courseTooltip.css({ top: e.pageY + 12, left: e.pageX + 12 }); // Đổi tên biến
    });
});